// Tests for detectDrift (plan §3.10, spec §13.3).
//
// detectDrift is read-only — it recomputes the expected winning_values + the
// expected catalog_pricing_current / catalog_inventory_current rows from
// observations + side-table data, then compares against what's actually
// stored. Discrepancies populate a DriftReport.
//
// Coverage:
//   1. No-drift case — projected winners equal stored winners → hasDrift=false.
//   2. Sync-attribute drift — values has a clear winner X but winning_values
//      stores Y → driftAttributes populated.
//   3. Pricing _current drift — pricing observation says source A, current
//      table has stale source B → driftPricingCurrentRows populated.
//   4. Inventory drift — same as pricing but with the NULL-location sentinel
//      path.
//   5. Tombstoned product (status='merged_into') — detectDrift returns
//      hasDrift=false (no observations to project — clean no-op).

import { afterAll, beforeAll, afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  TEST_CHANNEL_ID,
  TEST_LOCATION_ID,
  TEST_MERCHANT_ID,
  TEST_TENANT_ID,
  closeTestDb,
  connectTestDb,
  ensureTestChannel,
  ensureTestInventoryLocation,
  ensureTestMerchant,
  ensureTestTenant
} from "@aonex/db/testing";
import { detectDrift } from "./drift-detector.js";

const TEST_ACTOR = "test:watchdog-drift-detector";
const NULL_LOCATION_SENTINEL = "00000000-0000-0000-0000-000000000000";

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
  await db
    .delete(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.tenantId, TEST_TENANT_ID));
  await db.execute(
    sql`DELETE FROM catalog_pricing_current
        WHERE product_id IN (
          SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
        )`
  );
  await db.execute(
    sql`DELETE FROM catalog_inventory_current
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
  const inserted = await db
    .insert(schema.catalogProducts)
    .values(insertValues)
    .returning();
  return inserted[0]!.productId;
}

describe("detectDrift (plan §3.10, spec §13.3)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await ensureTestInventoryLocation(db);
    await cleanup(db);
    await seedRules(db);
  });

  afterEach(async () => {
    // Keep tenant/merchant/channel/location/rules; scrub per-test rows.
    await db
      .delete(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.catalogInventoryObservations)
      .where(eq(schema.catalogInventoryObservations.tenantId, TEST_TENANT_ID));
    await db.execute(
      sql`DELETE FROM catalog_pricing_current
          WHERE product_id IN (
            SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
          )`
    );
    await db.execute(
      sql`DELETE FROM catalog_inventory_current
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

  test("1. no-drift product → hasDrift=false", async () => {
    // Build values + winning_values where the projection of values matches
    // the stored winning_values. Pricing/inventory side tables also match.
    const productId = await insertProduct(db, {
      primaryIdentifier: "DRIFT-NO-1",
      values: {
        title: {
          _unscoped: {
            _unscoped: [
              {
                source: "shopify:connector",
                source_record_id: "shp#1",
                value: "Hero Widget",
                confidence: 1,
                observed_at: "2026-05-21T10:00:00Z"
              }
            ]
          }
        }
      },
      winningValues: {
        title: { _unscoped: { _unscoped: "Hero Widget" } }
      }
    });

    const report = await detectDrift({ db }, productId);

    expect(report.productId).toBe(productId);
    expect(report.tenantId).toBe(TEST_TENANT_ID);
    expect(report.hasDrift).toBe(false);
    expect(report.driftAttributes).toEqual([]);
    expect(report.driftPricingCurrentRows).toEqual([]);
    expect(report.driftInventoryCurrentRows).toEqual([]);
  });

  test("2. sync-attribute drift: values has clear winner but winning_values stores stale", async () => {
    // values says shopify wins (priority 1), but winning_values still
    // reflects the old ebay observation. detectDrift should flag the
    // mismatch on (title, _unscoped, _unscoped).
    const productId = await insertProduct(db, {
      primaryIdentifier: "DRIFT-SYNC-1",
      values: {
        title: {
          _unscoped: {
            _unscoped: [
              {
                source: "ebay:link",
                source_record_id: "eb#1",
                value: "Old Ebay Title",
                confidence: 1,
                observed_at: "2026-05-21T09:00:00Z"
              },
              {
                source: "shopify:connector",
                source_record_id: "shp#1",
                value: "New Shopify Title",
                confidence: 1,
                observed_at: "2026-05-21T10:00:00Z"
              }
            ]
          }
        }
      },
      winningValues: {
        title: { _unscoped: { _unscoped: "Old Ebay Title" } }
      }
    });

    const report = await detectDrift({ db }, productId);

    expect(report.hasDrift).toBe(true);
    expect(report.driftAttributes.length).toBe(1);
    const drift = report.driftAttributes[0]!;
    expect(drift.attributeCode).toBe("title");
    expect(drift.channel).toBe("_unscoped");
    expect(drift.locale).toBe("_unscoped");
    expect(drift.stored).toBe("Old Ebay Title");
    expect(drift.expected).toBe("New Shopify Title");
  });

  test("3. pricing _current drift: observation says shopify but current table has stale ebay row", async () => {
    const productId = await insertProduct(db, {
      primaryIdentifier: "DRIFT-PRC-1",
      values: {}
    });

    // Two pricing observations — shopify wins per the rules.
    await db.insert(schema.catalogPricingObservations).values([
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "ebay:link",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 120 }],
        observedAt: new Date("2026-05-21T10:00:00Z")
      },
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "shopify:connector",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 99.95 }],
        observedAt: new Date("2026-05-21T09:00:00Z")
      }
    ]);

    // Stale pricing_current row says ebay won — that's the drift we're catching.
    await db.execute(sql`
      INSERT INTO catalog_pricing_current
        (product_id, tenant_id, channel_id, locale, source, currency, tiers,
         price_per_unit, primary_amount, observed_at)
      VALUES
        (${productId}, ${TEST_TENANT_ID}, ${TEST_CHANNEL_ID}, 'en_AU', 'ebay:link', 'AUD',
         ${JSON.stringify([{ kind: "list", amount: 120 }])}::jsonb,
         NULL, 120, '2026-05-21T10:00:00Z')
    `);

    const report = await detectDrift({ db }, productId);

    expect(report.hasDrift).toBe(true);
    expect(report.driftPricingCurrentRows.length).toBe(1);
    const row = report.driftPricingCurrentRows[0]!;
    expect(row.channelId).toBe(TEST_CHANNEL_ID);
    expect(row.locale).toBe("en_AU");
    expect(row.stored?.source).toBe("ebay:link");
    expect(row.expected?.source).toBe("shopify:connector");
  });

  test("4. inventory drift with NULL-location sentinel path", async () => {
    const productId = await insertProduct(db, {
      primaryIdentifier: "DRIFT-INV-NULL",
      values: {}
    });

    await db.insert(schema.catalogInventoryObservations).values([
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locationId: null,
        qty: 7,
        source: "shopify:connector",
        observedAt: new Date("2026-05-21T10:00:00Z")
      },
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locationId: null,
        qty: 42,
        source: "ebay:link",
        observedAt: new Date("2026-05-21T09:00:00Z")
      }
    ]);

    // Stale current row — claims ebay wins with qty=42.
    await db.execute(sql`
      INSERT INTO catalog_inventory_current
        (product_id, tenant_id, channel_id, location_id, qty, source, observed_at)
      VALUES
        (${productId}, ${TEST_TENANT_ID}, ${TEST_CHANNEL_ID}, NULL, 42, 'ebay:link',
         '2026-05-21T09:00:00Z')
    `);

    const report = await detectDrift({ db }, productId);
    expect(report.hasDrift).toBe(true);
    expect(report.driftInventoryCurrentRows.length).toBe(1);
    const row = report.driftInventoryCurrentRows[0]!;
    expect(row.channelId).toBe(TEST_CHANNEL_ID);
    expect(row.locationIdCoalesced).toBe(NULL_LOCATION_SENTINEL);
    expect(row.stored?.qty).toBe(42);
    expect(row.expected?.qty).toBe(7);
    expect(row.expected?.source).toBe("shopify:connector");
  });

  test("5. tombstoned product (status='merged_into') with no observations → hasDrift=false", async () => {
    // detectDrift itself doesn't gate on status — the tier runners do. The
    // function returns hasDrift=false because there are no observations to
    // project, matching the stored (presumably empty/null) winners.
    const productId = await insertProduct(db, {
      primaryIdentifier: "DRIFT-TOMB",
      status: "merged_into",
      values: {},
      winningValues: {}
    });

    const report = await detectDrift({ db }, productId);
    expect(report.hasDrift).toBe(false);
  });

  test("6. pricing drift: currency mismatch between observation and stale _current row is flagged", async () => {
    // Coverage gap fix — `catalog_pricing_current` stores currency +
    // pricePerUnit alongside source/tiers/primary_amount. A writer-vs-current
    // divergence on currency must be visible to the watchdog. Seed an
    // observation with currency=USD but a stale current row with currency=AUD
    // (same source, same tiers) → drift detected on the currency mismatch.
    const productId = await insertProduct(db, {
      primaryIdentifier: "DRIFT-PRC-CURRENCY",
      values: {}
    });

    const tiers = [{ kind: "list", amount: 49.99 }];
    await db.insert(schema.catalogPricingObservations).values([
      {
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locale: "en_AU",
        source: "shopify:connector",
        currency: "USD",
        tiers,
        observedAt: new Date("2026-05-21T10:00:00Z")
      }
    ]);
    // Stale current row — same source + tiers, but stale currency=AUD.
    await db.execute(sql`
      INSERT INTO catalog_pricing_current
        (product_id, tenant_id, channel_id, locale, source, currency, tiers,
         price_per_unit, primary_amount, observed_at)
      VALUES
        (${productId}, ${TEST_TENANT_ID}, ${TEST_CHANNEL_ID}, 'en_AU', 'shopify:connector', 'AUD',
         ${JSON.stringify(tiers)}::jsonb,
         NULL, 49.99, '2026-05-21T10:00:00Z')
    `);

    const report = await detectDrift({ db }, productId);
    expect(report.hasDrift).toBe(true);
    expect(report.driftPricingCurrentRows.length).toBe(1);
    const row = report.driftPricingCurrentRows[0]!;
    expect(row.stored?.currency).toBe("AUD");
    expect(row.expected?.currency).toBe("USD");
    // Source unchanged — the drift is solely on currency.
    expect(row.stored?.source).toBe("shopify:connector");
    expect(row.expected?.source).toBe("shopify:connector");
  });

  test("7. inventory drift case where current row exists but expected has no winner — flagged as orphan", async () => {
    // Edge case from spec: current row exists but no observation projects a
    // winner (e.g. observations were dropped by rule filtering). Expected
    // is null; stored row exists → drift, auto-fix would DELETE the orphan.
    const productId = await insertProduct(db, {
      primaryIdentifier: "DRIFT-INV-ORPHAN",
      values: {}
    });

    // No observations seeded — but a stale current row exists.
    await db.execute(sql`
      INSERT INTO catalog_inventory_current
        (product_id, tenant_id, channel_id, location_id, qty, source, observed_at)
      VALUES
        (${productId}, ${TEST_TENANT_ID}, ${TEST_CHANNEL_ID}, ${TEST_LOCATION_ID}, 99,
         'orphan-source', '2026-05-21T08:00:00Z')
    `);

    const report = await detectDrift({ db }, productId);
    expect(report.hasDrift).toBe(true);
    expect(report.driftInventoryCurrentRows.length).toBe(1);
    const row = report.driftInventoryCurrentRows[0]!;
    expect(row.stored?.qty).toBe(99);
    expect(row.expected).toBeNull();
  });
});
