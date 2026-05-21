// Tests for the identity update policy gate (plan §3.7, spec §6.1).
//
// Runs against the real dev DB via @aonex/db/testing helpers. Each scenario
// seeds a catalog_products row scoped to TEST_TENANT_ID and inline
// source_priority rules tagged with TEST_ACTOR for scoped cleanup.
//
// The policy gate covers four identity fields:
//   - gtin / mpn   → single priority-1 source can update; two disagreeing
//                    priority-1 sources freeze + emit review_task
//   - brand / model_number → 3 consecutive matching priority-1 observations
//                            required before update
// Plus auto-unfreeze after 5 consecutive matching priority-1 observations
// and strength-low freeze guard.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  TEST_MERCHANT_ID,
  TEST_TENANT_ID,
  closeTestDb,
  connectTestDb,
  ensureTestMerchant,
  ensureTestTenant
} from "@aonex/db/testing";
import { applyIdentityObservation } from "./identity-policy.js";

const TEST_ACTOR = "test:identity-policy";

// Seed source_priority rules:
//   - shopify:* and ebay:* are BOTH priority=1 (so we can force a
//     disagreement between two priority-1 sources)
//   - csv:* is priority=2 (non-priority-1; should not satisfy gating)
//   - catch-all wildcard at priority=100
//
// Rules are seeded with attributeCode=null so they apply to every identity
// field uniformly. The policy module decides priority-1 by looking up the
// best matching rule for the (attributeCode, source) combo.
async function seedRules(db: DrizzleClient): Promise<void> {
  await db.insert(schema.sourcePriority).values([
    {
      tenantId: null,
      attributeCode: null,
      sourceGlob: "shopify:*",
      channelScope: null,
      priority: 1,
      rulesVersion: 1,
      actor: TEST_ACTOR
    },
    {
      tenantId: null,
      attributeCode: null,
      sourceGlob: "ebay:*",
      channelScope: null,
      priority: 1,
      rulesVersion: 1,
      actor: TEST_ACTOR
    },
    {
      tenantId: null,
      attributeCode: null,
      sourceGlob: "csv:*",
      channelScope: null,
      priority: 2,
      rulesVersion: 1,
      actor: TEST_ACTOR
    },
    {
      tenantId: null,
      attributeCode: null,
      sourceGlob: "*",
      channelScope: null,
      priority: 100,
      rulesVersion: 1,
      actor: TEST_ACTOR
    }
  ]);
}

async function cleanup(db: DrizzleClient): Promise<void> {
  await db
    .delete(schema.identityLog)
    .where(eq(schema.identityLog.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.reviewTasks)
    .where(eq(schema.reviewTasks.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
}

/** Append a brand observation entry into `values.brand._unscoped._unscoped[]`. */
function brandLeaf(
  observations: Array<{
    source: string;
    value: string;
    observed_at: string;
    source_record_id?: string;
    confidence?: number;
  }>
) {
  return {
    brand: {
      _unscoped: {
        _unscoped: observations.map((o) => ({
          source: o.source,
          source_record_id: o.source_record_id ?? `${o.source}#1`,
          value: o.value,
          confidence: o.confidence ?? 1.0,
          observed_at: o.observed_at
        }))
      }
    }
  };
}

describe("applyIdentityObservation (plan §3.7, spec §6.1)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await cleanup(db);
    await seedRules(db);
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  beforeEach(async () => {
    // Per-test scoped cleanup: products + identity_log + review_tasks. We
    // keep the seeded rules in place across tests so they only seed once.
    await db
      .delete(schema.identityLog)
      .where(eq(schema.identityLog.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.reviewTasks)
      .where(eq(schema.reviewTasks.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  });

  test("1. single priority-1 GTIN observation updates identity and logs", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "ip-001",
        identity: { identity_strength: 1.0 },
        status: "active",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const productId = inserted[0]!.productId;

    const result = await applyIdentityObservation({
      db,
      productId,
      field: "gtin",
      proposedValue: "01000000000001",
      source: "shopify:connector",
      sourceRecordId: "rec-1",
      observedAt: new Date("2026-05-21T10:00:00Z")
    });

    expect(result.applied).toBe(true);
    expect(result.frozen).toBe(false);
    expect(result.identityLogId).toBeDefined();

    const row = await db
      .select({
        identity: schema.catalogProducts.identity,
        status: schema.catalogProducts.status
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const identity = row[0]!.identity as Record<string, unknown>;
    expect(identity.gtin).toBe("01000000000001");
    expect(row[0]!.status).toBe("active");

    const logs = await db
      .select()
      .from(schema.identityLog)
      .where(eq(schema.identityLog.productId, productId));
    expect(logs.length).toBe(1);
    expect(logs[0]!.identityField).toBe("gtin");
    expect(logs[0]!.newValue).toBe("01000000000001");
    expect(logs[0]!.source).toBe("shopify:connector");
  });

  test("2. two priority-1 GTIN sources disagree → freeze + review_task", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "ip-002",
        identity: { gtin: "GTIN-A", identity_strength: 1.0 },
        status: "active",
        // Pre-seeded with a priority-1 shopify observation of GTIN-A; the
        // incoming priority-1 ebay observation will disagree.
        values: {
          gtin: {
            _unscoped: {
              _unscoped: [
                {
                  source: "shopify:connector",
                  source_record_id: "rec-shopify-a",
                  value: "GTIN-A",
                  confidence: 1.0,
                  observed_at: "2026-05-20T10:00:00Z"
                }
              ]
            }
          }
        }
      })
      .returning({ productId: schema.catalogProducts.productId });
    const productId = inserted[0]!.productId;

    const result = await applyIdentityObservation({
      db,
      productId,
      field: "gtin",
      proposedValue: "GTIN-B",
      source: "ebay:connector",
      sourceRecordId: "rec-ebay-b",
      observedAt: new Date("2026-05-21T10:00:00Z")
    });

    expect(result.applied).toBe(false);
    expect(result.frozen).toBe(true);
    expect(result.reviewTaskId).toBeDefined();

    const row = await db
      .select({
        identity: schema.catalogProducts.identity,
        status: schema.catalogProducts.status
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const identity = row[0]!.identity as Record<string, unknown>;
    expect(identity.gtin).toBe("GTIN-A");
    expect(row[0]!.status).toBe("frozen_pending_review");

    const tasks = await db
      .select()
      .from(schema.reviewTasks)
      .where(eq(schema.reviewTasks.tenantId, TEST_TENANT_ID));
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.taskType).toBe("value_conflict");
    expect(tasks[0]!.signalKind).toBe("identity_disagreement");
    const payload = tasks[0]!.signalPayload as Record<string, unknown>;
    expect(payload.field).toBe("gtin");
    expect(Array.isArray(payload.observedValues)).toBe(true);

    const logs = await db
      .select()
      .from(schema.identityLog)
      .where(eq(schema.identityLog.productId, productId));
    expect(logs.length).toBe(1);
    expect(logs[0]!.rationale).toBe("freeze_gtin_disagreement");
  });

  test("3. brand requires 3 consecutive priority-1 observations", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "ip-003",
        identity: { brand: "OldBrand", identity_strength: 1.0 },
        status: "active",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const productId = inserted[0]!.productId;

    async function pushBrandObs(value: string, n: number, isoOffsetMin: number) {
      // Simulate catalog-write appending an observation BEFORE calling the
      // policy gate. The gate counts existing prior matching observations
      // plus the incoming as the consecutive count.
      const row = await db
        .select({ values: schema.catalogProducts.values })
        .from(schema.catalogProducts)
        .where(eq(schema.catalogProducts.productId, productId));
      const values = (row[0]!.values ?? {}) as Record<string, any>;
      const nextValues = JSON.parse(JSON.stringify(values));
      const merged = {
        ...nextValues,
        ...brandLeaf([
          ...(nextValues.brand?._unscoped?._unscoped ?? []).map((o: any) => ({
            source: o.source,
            value: o.value,
            observed_at: o.observed_at,
            source_record_id: o.source_record_id,
            confidence: o.confidence
          })),
          {
            source: "shopify:connector",
            value,
            observed_at: new Date(
              Date.parse("2026-05-21T10:00:00Z") + isoOffsetMin * 60_000
            ).toISOString(),
            source_record_id: `rec-${n}`
          }
        ])
      };
      await db
        .update(schema.catalogProducts)
        .set({ values: merged })
        .where(eq(schema.catalogProducts.productId, productId));
    }

    // 1st observation
    await pushBrandObs("NewBrand", 1, 0);
    const r1 = await applyIdentityObservation({
      db,
      productId,
      field: "brand",
      proposedValue: "NewBrand",
      source: "shopify:connector",
      sourceRecordId: "rec-1",
      observedAt: new Date("2026-05-21T10:00:00Z")
    });
    expect(r1.applied).toBe(false);
    expect(r1.frozen).toBe(false);

    // 2nd observation
    await pushBrandObs("NewBrand", 2, 1);
    const r2 = await applyIdentityObservation({
      db,
      productId,
      field: "brand",
      proposedValue: "NewBrand",
      source: "shopify:connector",
      sourceRecordId: "rec-2",
      observedAt: new Date("2026-05-21T10:01:00Z")
    });
    expect(r2.applied).toBe(false);
    expect(r2.frozen).toBe(false);

    // 3rd observation triggers the update
    await pushBrandObs("NewBrand", 3, 2);
    const r3 = await applyIdentityObservation({
      db,
      productId,
      field: "brand",
      proposedValue: "NewBrand",
      source: "shopify:connector",
      sourceRecordId: "rec-3",
      observedAt: new Date("2026-05-21T10:02:00Z")
    });
    expect(r3.applied).toBe(true);
    expect(r3.frozen).toBe(false);

    const row = await db
      .select({ identity: schema.catalogProducts.identity })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const identity = row[0]!.identity as Record<string, unknown>;
    expect(identity.brand).toBe("NewBrand");

    // No-op calls #1 and #2 should NOT have created identity_log rows; only
    // the applied call #3 does.
    const logs = await db
      .select()
      .from(schema.identityLog)
      .where(eq(schema.identityLog.productId, productId));
    expect(logs.length).toBe(1);
    expect(logs[0]!.newValue).toBe("NewBrand");
  });

  test("4. auto-unfreeze after 5 consecutive matching priority-1 observations", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "ip-004",
        identity: { gtin: "X", identity_strength: 1.0 },
        status: "frozen_pending_review",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const productId = inserted[0]!.productId;

    // Pre-seed an identity_log row representing the prior freeze, so the
    // auto-unfreeze counter starts from after that point.
    await db.insert(schema.identityLog).values({
      productId,
      tenantId: TEST_TENANT_ID,
      identityField: "gtin",
      oldValue: "X",
      newValue: null,
      source: "shopify:connector",
      sourceRecordId: "freeze-rec",
      observedAt: new Date("2026-05-20T00:00:00Z"),
      rationale: "freeze_gtin_disagreement"
    });

    // Apply 5 matching priority-1 observations. Between calls we push the
    // observation into `values.gtin._unscoped._unscoped[]` (mimicking what
    // catalog-write does) so the policy gate can count them on the next
    // pass.
    async function pushGtinObs(
      value: string,
      isoOffsetMin: number,
      sourceRecordId: string
    ) {
      const row = await db
        .select({ values: schema.catalogProducts.values })
        .from(schema.catalogProducts)
        .where(eq(schema.catalogProducts.productId, productId));
      const values = (row[0]!.values ?? {}) as Record<string, any>;
      const next = JSON.parse(JSON.stringify(values));
      next.gtin = next.gtin ?? {};
      next.gtin._unscoped = next.gtin._unscoped ?? {};
      next.gtin._unscoped._unscoped = next.gtin._unscoped._unscoped ?? [];
      next.gtin._unscoped._unscoped.push({
        source: "shopify:connector",
        source_record_id: sourceRecordId,
        value,
        confidence: 1.0,
        observed_at: new Date(
          Date.parse("2026-05-21T10:00:00Z") + isoOffsetMin * 60_000
        ).toISOString()
      });
      await db
        .update(schema.catalogProducts)
        .set({ values: next })
        .where(eq(schema.catalogProducts.productId, productId));
    }

    for (let i = 0; i < 5; i++) {
      await pushGtinObs("X", i, `match-${i}`);
      const r = await applyIdentityObservation({
        db,
        productId,
        field: "gtin",
        proposedValue: "X",
        source: "shopify:connector",
        sourceRecordId: `match-${i}`,
        observedAt: new Date(
          Date.parse("2026-05-21T10:00:00Z") + i * 60_000
        )
      });
      // Frozen state blocks identity application until unfreeze.
      if (i < 4) {
        expect(r.applied).toBe(false);
      }
    }

    const row = await db
      .select({
        status: schema.catalogProducts.status,
        identity: schema.catalogProducts.identity
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    expect(row[0]!.status).toBe("active");
    const identity = row[0]!.identity as Record<string, unknown>;
    expect(identity.gtin).toBe("X"); // unchanged — matched current value

    const logs = await db
      .select()
      .from(schema.identityLog)
      .where(
        and(
          eq(schema.identityLog.productId, productId),
          eq(
            schema.identityLog.rationale,
            "auto_unfrozen_after_consistent_signal"
          )
        )
      );
    expect(logs.length).toBe(1);
  });

  test("5. freeze blocks identity but not value observations (mpn blocked)", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "ip-005",
        identity: { mpn: "MPN-OLD", identity_strength: 1.0 },
        status: "frozen_pending_review",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const productId = inserted[0]!.productId;

    const result = await applyIdentityObservation({
      db,
      productId,
      field: "mpn",
      proposedValue: "MPN-NEW",
      source: "shopify:connector",
      sourceRecordId: "rec-mpn",
      observedAt: new Date("2026-05-21T10:00:00Z")
    });
    expect(result.applied).toBe(false);
    expect(result.frozen).toBe(true);

    const row = await db
      .select({ identity: schema.catalogProducts.identity })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const identity = row[0]!.identity as Record<string, unknown>;
    expect(identity.mpn).toBe("MPN-OLD"); // unchanged
  });

  test("6. identity_strength < 0.7 freezes identity update", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "ip-006",
        identity: { identity_strength: 0.5 },
        status: "active",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const productId = inserted[0]!.productId;

    const result = await applyIdentityObservation({
      db,
      productId,
      field: "gtin",
      proposedValue: "G-STRENGTH-LOW",
      source: "shopify:connector",
      sourceRecordId: "rec-low",
      observedAt: new Date("2026-05-21T10:00:00Z")
    });
    expect(result.applied).toBe(false);
    expect(result.frozen).toBe(true);

    const row = await db
      .select({
        identity: schema.catalogProducts.identity,
        status: schema.catalogProducts.status
      })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const identity = row[0]!.identity as Record<string, unknown>;
    expect(identity.gtin).toBeUndefined();
    expect(row[0]!.status).toBe("frozen_pending_review");

    const logs = await db
      .select()
      .from(schema.identityLog)
      .where(eq(schema.identityLog.productId, productId));
    expect(logs.length).toBe(1);
    expect(logs[0]!.rationale).toBe("freeze_identity_strength_low");
  });

  test("7. non-priority-1 source single observation does not update identity", async () => {
    // Defensive scenario: a csv:* observation (priority=2) should NOT count
    // as a strong single-source signal for gtin. The update should be
    // deferred (no-op) rather than applied.
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "ip-007",
        identity: { identity_strength: 1.0 },
        status: "active",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const productId = inserted[0]!.productId;

    const result = await applyIdentityObservation({
      db,
      productId,
      field: "gtin",
      proposedValue: "GTIN-CSV",
      source: "csv:upload",
      sourceRecordId: "rec-csv",
      observedAt: new Date("2026-05-21T10:00:00Z")
    });
    expect(result.applied).toBe(false);
    expect(result.frozen).toBe(false);

    const row = await db
      .select({ identity: schema.catalogProducts.identity })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const identity = row[0]!.identity as Record<string, unknown>;
    expect(identity.gtin).toBeUndefined();
  });
});
