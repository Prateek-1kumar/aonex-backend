// Tests for applyIdentityObservation, the identity update policy gate.
// Runs against the real dev DB via @aonex/db/testing helpers; each scenario
// seeds a catalog_products row scoped to TEST_TENANT_ID plus inline
// source_priority rules tagged TEST_ACTOR for scoped cleanup.

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
      sourceGlob: "connector:*",
      channelScope: null,
      priority: 1,
      rulesVersion: 1,
      actor: TEST_ACTOR
    },
    {
      tenantId: null,
      attributeCode: null,
      sourceGlob: "link:*",
      channelScope: null,
      priority: 1,
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

    await db.insert(schema.identityLog).values({
      productId,
      tenantId: TEST_TENANT_ID,
      identityField: "gtin",
      oldValue: "X",
      newValue: null,
      source: "shopify:connector",
      sourceRecordId: "freeze-rec",
      observedAt: new Date("2025-01-01T00:00:00Z"),
      appliedAt: new Date("2025-01-01T00:00:00Z"),
      rationale: "freeze_gtin_disagreement"
    });

    const OBS_BASE = "2025-06-01T10:00:00Z";

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
          Date.parse(OBS_BASE) + isoOffsetMin * 60_000
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
        observedAt: new Date(Date.parse(OBS_BASE) + i * 60_000)
      });
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
    expect(identity.gtin).toBe("X");

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
    expect(identity.mpn).toBe("MPN-OLD");
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

  test("8. freeze row is still found behind >20 newer non-freeze rows", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "ip-008",
        identity: { gtin: "Y", identity_strength: 1.0 },
        status: "frozen_pending_review",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const productId = inserted[0]!.productId;

    await db.insert(schema.identityLog).values({
      productId,
      tenantId: TEST_TENANT_ID,
      identityField: "gtin",
      oldValue: "Y",
      newValue: null,
      source: "shopify:connector",
      sourceRecordId: "freeze-old",
      observedAt: new Date("2025-01-01T00:00:00Z"),
      appliedAt: new Date("2025-01-01T00:00:00Z"),
      rationale: "freeze_gtin_disagreement"
    });

    for (let i = 0; i < 25; i++) {
      await db.insert(schema.identityLog).values({
        productId,
        tenantId: TEST_TENANT_ID,
        identityField: "gtin",
        oldValue: "Y",
        newValue: "Y",
        source: "shopify:connector",
        sourceRecordId: `noise-${i}`,
        observedAt: new Date(
          Date.parse("2025-06-01T00:00:00Z") + i * 60_000
        ),
        appliedAt: new Date(
          Date.parse("2025-06-01T00:00:00Z") + i * 60_000
        ),
        rationale: "single_priority_one_source"
      });
    }

    const preFreezeObs = Array.from({ length: 4 }, (_, i) => ({
      source: "shopify:connector",
      source_record_id: `pre-freeze-${i}`,
      value: "Y",
      confidence: 1.0,
      observed_at: new Date(
        Date.parse("2024-12-01T00:00:00Z") + i * 60_000
      ).toISOString()
    }));
    await db
      .update(schema.catalogProducts)
      .set({
        values: {
          gtin: {
            _unscoped: {
              _unscoped: preFreezeObs
            }
          }
        }
      })
      .where(eq(schema.catalogProducts.productId, productId));

    const r = await applyIdentityObservation({
      db,
      productId,
      field: "gtin",
      proposedValue: "Y",
      source: "shopify:connector",
      sourceRecordId: "incoming-after",
      observedAt: new Date("2025-06-15T00:00:00Z")
    });
    expect(r.applied).toBe(false);
    expect(r.frozen).toBe(true);

    const row = await db
      .select({ status: schema.catalogProducts.status })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    expect(row[0]!.status).toBe("frozen_pending_review");
  });

  test("9. boundary guards: invalid field and empty proposedValue throw", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "ip-009",
        identity: { identity_strength: 1.0 },
        status: "active",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const productId = inserted[0]!.productId;

    await expect(
      applyIdentityObservation({
        db,
        productId,
        // @ts-expect-error — exercising the runtime guard against caller bugs
        field: "color",
        proposedValue: "red",
        source: "shopify:connector",
        sourceRecordId: "rec-bad",
        observedAt: new Date("2025-06-01T00:00:00Z")
      })
    ).rejects.toThrow(/invalid field/);

    await expect(
      applyIdentityObservation({
        db,
        productId,
        field: "gtin",
        proposedValue: "",
        source: "shopify:connector",
        sourceRecordId: "rec-empty",
        observedAt: new Date("2025-06-01T00:00:00Z")
      })
    ).rejects.toThrow(/non-empty string/);
  });

  test("10. brand: a conflicting priority-1 observation breaks the streak", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "ip-010",
        identity: { brand: "OldBrand", identity_strength: 1.0 },
        status: "active",
        values: brandLeaf([
          {
            source: "shopify:connector",
            value: "NewBrand",
            source_record_id: "rec-shop-1",
            observed_at: "2025-06-01T10:00:00Z"
          },
          {
            source: "ebay:connector",
            value: "OtherBrand",
            source_record_id: "rec-ebay-mid",
            observed_at: "2025-06-01T10:01:00Z"
          },
          {
            source: "shopify:connector",
            value: "NewBrand",
            source_record_id: "rec-shop-2",
            observed_at: "2025-06-01T10:02:00Z"
          }
        ])
      })
      .returning({ productId: schema.catalogProducts.productId });
    const productId = inserted[0]!.productId;

    const r = await applyIdentityObservation({
      db,
      productId,
      field: "brand",
      proposedValue: "NewBrand",
      source: "shopify:connector",
      sourceRecordId: "rec-shop-3-incoming",
      observedAt: new Date("2025-06-01T10:03:00Z")
    });
    expect(r.applied).toBe(false);
    expect(r.frozen).toBe(false);

    const row = await db
      .select({ identity: schema.catalogProducts.identity })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const identity = row[0]!.identity as Record<string, unknown>;
    expect(identity.brand).toBe("OldBrand");
  });

  test("11. authority guard: lower-authority cannot overwrite higher", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "ip-011",
        identity: { gtin: "01000000000011", identity_strength: 1.0 },
        status: "active",
        values: {}
      })
      .returning({ productId: schema.catalogProducts.productId });
    const productId = inserted[0]!.productId;

    await db.insert(schema.identityLog).values({
      productId,
      tenantId: TEST_TENANT_ID,
      identityField: "gtin",
      oldValue: null,
      newValue: "01000000000011",
      source: "connector:shopify",
      sourceRecordId: "shop-1",
      observedAt: new Date("2026-05-20T10:00:00Z"),
      rationale: "single_priority_one_source"
    });

    const blocked = await applyIdentityObservation({
      db,
      productId,
      field: "gtin",
      proposedValue: "02000000000012",
      source: "link:croma",
      sourceRecordId: "rec-link-1",
      observedAt: new Date("2026-05-22T10:00:00Z")
    });
    expect(blocked.applied).toBe(false);
    expect(blocked.reason).toBe("lower_authority");

    const rowAfterBlock = await db
      .select({ identity: schema.catalogProducts.identity })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    expect(
      (rowAfterBlock[0]!.identity as Record<string, unknown>).gtin
    ).toBe("01000000000011");

    const allowed = await applyIdentityObservation({
      db,
      productId,
      field: "gtin",
      proposedValue: "03000000000013",
      source: "connector:amazon",
      sourceRecordId: "rec-amzn-1",
      observedAt: new Date("2026-05-23T10:00:00Z")
    });
    expect(allowed.applied).toBe(true);

    const rowAfterAllow = await db
      .select({ identity: schema.catalogProducts.identity })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    expect(
      (rowAfterAllow[0]!.identity as Record<string, unknown>).gtin
    ).toBe("03000000000013");
  });
});
