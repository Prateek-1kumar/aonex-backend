// Tests for runContinuous (plan §3.10, spec §13.3 — continuous tier).
//
// Samples 1% of products updated in the last 5 minutes; per-sample, detects
// drift, runs auto-fix, aggregates stats.
//
// Coverage:
//   1. Drift triggers auto-fix — with a single recent product carrying known
//      drift, runContinuous samples it (sample = ceil(1/100) on tiny tables;
//      we just need 1 product to guarantee sampling), detects drift, and
//      repairs sync winners via autoFixDrift.
//   2. Empty window — no recent products → sampled=0, driftFound=0.
//   3. Tombstoned exclusion — a recent product with status='merged_into'
//      must NOT be sampled.

import { afterAll, beforeAll, afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  TEST_CHANNEL_ID,
  TEST_MERCHANT_ID,
  TEST_TENANT_ID,
  closeTestDb,
  connectTestDb,
  ensureTestChannel,
  ensureTestMerchant,
  ensureTestTenant
} from "@aonex/db/testing";
import { runContinuous } from "./continuous.js";

const TEST_ACTOR = "test:watchdog-continuous";

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
    .delete(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID));
  await db.execute(
    sql`DELETE FROM catalog_pricing_current
        WHERE product_id IN (
          SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
        )`
  );
  await db.execute(
    sql`DELETE FROM catalog_events WHERE tenant_id = ${TEST_TENANT_ID}`
  );
  await db
    .update(schema.catalogProducts)
    .set({ parentProductId: null, mergedIntoProductId: null })
    .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
}

async function insertProduct(
  db: DrizzleClient,
  opts: {
    primaryIdentifier: string;
    values?: Record<string, unknown>;
    winningValues?: Record<string, unknown>;
    status?: string;
    updatedAt?: Date;
  }
): Promise<string> {
  const insertValues: typeof schema.catalogProducts.$inferInsert = {
    tenantId: TEST_TENANT_ID,
    merchantId: TEST_MERCHANT_ID,
    primaryIdentifier: opts.primaryIdentifier,
    identity: { brand: "Acme" },
    status: opts.status ?? "active",
    values: opts.values ?? {}
  };
  if (opts.winningValues !== undefined) {
    insertValues.winningValues = opts.winningValues;
  }
  const rows = await db
    .insert(schema.catalogProducts)
    .values(insertValues)
    .returning();
  const id = rows[0]!.productId;
  if (opts.updatedAt) {
    // Backdate updated_at — bypasses default now() so we can put a product
    // outside the 5-minute window.
    await db
      .update(schema.catalogProducts)
      .set({ updatedAt: opts.updatedAt })
      .where(eq(schema.catalogProducts.productId, id));
  }
  return id;
}

describe("runContinuous (plan §3.10, spec §13.3 — continuous tier)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await cleanup(db);
    await seedRules(db);
  });

  afterEach(async () => {
    await db
      .delete(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID));
    await db.execute(
      sql`DELETE FROM catalog_pricing_current
          WHERE product_id IN (
            SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
          )`
    );
    await db.execute(
      sql`DELETE FROM catalog_events WHERE tenant_id = ${TEST_TENANT_ID}`
    );
    await db
      .update(schema.catalogProducts)
      .set({ parentProductId: null, mergedIntoProductId: null })
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  test("1. drift triggers auto-fix in the recent window", async () => {
    // Single recent product with sync drift. The continuous sampler uses
    // `ORDER BY random() LIMIT ceil(n_recent / 100)` — with n_recent=1 the
    // LIMIT is 1 so this product gets picked.
    const productId = await insertProduct(db, {
      primaryIdentifier: "CONT-DRIFT-1",
      values: {
        title: {
          _unscoped: {
            _unscoped: [
              {
                source: "shopify:connector",
                source_record_id: "shp#1",
                value: "Correct Title",
                confidence: 1,
                observed_at: "2026-05-21T10:00:00Z"
              }
            ]
          }
        }
      },
      winningValues: { title: { _unscoped: { _unscoped: "Stale Title" } } }
    });

    const stats = await runContinuous({ db });

    expect(stats.sampled).toBeGreaterThanOrEqual(1);
    expect(stats.driftFound).toBe(1);
    expect(stats.autoFixed).toBe(1);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(stats.driftRateByAttribute.title).toBe(1);

    // winning_values now matches the expected winner.
    const after = await db
      .select({ winningValues: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const wv = after[0]!.winningValues as Record<string, any>;
    expect(wv.title._unscoped._unscoped).toBe("Correct Title");
  });

  test("2. empty recent window → sampled=0, returns cleanly", async () => {
    // Seed one product but backdate it to outside the 5-minute window.
    await insertProduct(db, {
      primaryIdentifier: "CONT-OLD-1",
      updatedAt: new Date(Date.now() - 1000 * 60 * 60) // 1 hour ago
    });

    const stats = await runContinuous({ db });
    expect(stats.sampled).toBe(0);
    expect(stats.driftFound).toBe(0);
    expect(stats.autoFixed).toBe(0);
  });

  test("3a. async drift with no queue → asyncDeferred bumps, autoFixed does NOT", async () => {
    // Stats honesty (Fix 7): when there's pricing/inventory drift but no
    // Queue is wired into runContinuous, autoFixDrift logs the skip + returns
    // asyncDeferred>0. The tier runner must NOT count that product toward
    // `autoFixed` — it bumps `asyncDeferred` instead.
    const productId = await insertProduct(db, {
      primaryIdentifier: "CONT-ASYNCDEF-1",
      values: {}
    });
    await db.insert(schema.catalogPricingObservations).values([
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "shopify:connector",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 19.95 }],
        observedAt: new Date()
      }
    ]);
    // No catalog_pricing_current row → drift exists; runContinuous is
    // invoked WITHOUT a queue so the fix is deferred.

    const stats = await runContinuous({ db });

    expect(stats.sampled).toBeGreaterThanOrEqual(1);
    expect(stats.driftFound).toBe(1);
    expect(stats.asyncDeferred).toBe(1);
    // Critical: autoFixed must NOT include the deferred product.
    expect(stats.autoFixed).toBe(0);
  });

  test("3. tombstoned product is excluded from the sample", async () => {
    // Recent merged_into product. Must NOT be sampled even though it falls
    // in the 5-minute window.
    await insertProduct(db, {
      primaryIdentifier: "CONT-TOMB-1",
      status: "merged_into",
      values: {
        title: {
          _unscoped: {
            _unscoped: [
              {
                source: "shopify:connector",
                source_record_id: "shp#1",
                value: "Real Title",
                confidence: 1,
                observed_at: "2026-05-21T10:00:00Z"
              }
            ]
          }
        }
      },
      winningValues: { title: { _unscoped: { _unscoped: "Stale Title" } } }
    });

    const stats = await runContinuous({ db });
    expect(stats.sampled).toBe(0);
    expect(stats.driftFound).toBe(0);
  });
});
