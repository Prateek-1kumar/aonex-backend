// Integration tests for the catalog_pricing schema (observations + current,
// partitioning, indexes) against a live Postgres.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { schema } from "../index.js";
import { connectTestDb, closeTestDb } from "../testing/connect.js";
import { ensureTestTenant, TEST_TENANT_ID } from "../testing/seed-tenant.js";
import { ensureTestMerchant } from "../testing/seed-merchant.js";
import { ensureTestChannel, TEST_CHANNEL_ID } from "../testing/seed-channel.js";
import type { DrizzleClient } from "../client.js";

describe("catalog_pricing schema", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await db
      .delete(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.catalogPricingCurrent)
      .where(eq(schema.catalogPricingCurrent.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await db
      .delete(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.catalogPricingCurrent)
      .where(eq(schema.catalogPricingCurrent.tenantId, TEST_TENANT_ID));
    await closeTestDb();
  });

  test("accepts a pricing observation insert and auto-assigns observation_id + ingested_at", async () => {
    const productId = randomUUID();
    const observedAt = new Date("2026-05-15T10:00:00Z");
    const rows = await db
      .insert(schema.catalogPricingObservations)
      .values({
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        source: "shopify:connector",
        sourceRecordId: "gid://shopify/Product/123",
        currency: "AUD",
        tiers: [
          { kind: "list", amount: 1299.0 },
          { kind: "sale", amount: 1149.0 }
        ],
        observedAt
      })
      .returning();
    const row = rows[0]!;

    expect(row.observationId).toBeGreaterThan(0);
    expect(row.productId).toBe(productId);
    expect(row.tenantId).toBe(TEST_TENANT_ID);
    expect(row.channelId).toBe(TEST_CHANNEL_ID);
    expect(row.currency).toBe("AUD");
    expect(row.locale).toBe("_unscoped");
    expect(row.ingestedAt).toBeInstanceOf(Date);
  });

  test("app code inserts into catalog_pricing_current (no DB trigger)", async () => {
    const productId = randomUUID();
    const observedAt = new Date("2026-05-16T10:00:00Z");
    const rows = await db
      .insert(schema.catalogPricingCurrent)
      .values({
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        source: "shopify:connector",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 99.95 }],
        primaryAmount: "99.95",
        observedAt
      })
      .returning();
    const row = rows[0]!;

    expect(row.productId).toBe(productId);
    expect(row.channelId).toBe(TEST_CHANNEL_ID);
    expect(row.locale).toBe("_unscoped");
    expect(row.currency).toBe("AUD");
    expect(Number(row.primaryAmount)).toBeCloseTo(99.95);
  });

  test("(product_id, channel_id, observed_at DESC) index is used for latest-per-channel lookup", async () => {
    const observedBase = new Date("2026-05-20T00:00:00Z").getTime();
    const productIds = Array.from({ length: 10 }, () => randomUUID());
    const bulkValues = Array.from({ length: 50 }, (_, i) => ({
      productId: productIds[i % productIds.length]!,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      source: "shopify:connector",
      currency: "AUD",
      tiers: [{ kind: "list", amount: 10 + i }],
      observedAt: new Date(observedBase + i * 60_000)
    }));

    await db.insert(schema.catalogPricingObservations).values(bulkValues).execute();

    await db.execute(sql`ANALYZE catalog_pricing_observations`);

    await db.execute(sql`SET enable_seqscan = OFF`);

    const target = productIds[0]!;
    const plan = await db.execute(
      sql`EXPLAIN (FORMAT JSON)
          SELECT * FROM catalog_pricing_observations
          WHERE product_id = ${target} AND channel_id = ${TEST_CHANNEL_ID}
          ORDER BY observed_at DESC
          LIMIT 1`
    );

    await db.execute(sql`SET enable_seqscan = ON`);

    const planJson = JSON.stringify(plan.rows);
    expect(planJson).toMatch(/Index Scan|Index Only Scan/);
  });

  test("parent observations table is partitioned by range on observed_at", async () => {
    const result = await db.execute(sql`
      SELECT partstrat FROM pg_partitioned_table
      WHERE partrelid = 'catalog_pricing_observations'::regclass
    `);
    const row = result.rows[0]!;
    expect(row.partstrat).toBe("r");
  });

  test("monthly partitions exist for 2026-05, 2026-06, 2026-07", async () => {
    const result = await db.execute(sql`
      SELECT relname FROM pg_class
      WHERE relname IN (
        'catalog_pricing_observations_2026_05',
        'catalog_pricing_observations_2026_06',
        'catalog_pricing_observations_2026_07'
      )
      ORDER BY relname
    `);
    expect(result.rows.length).toBe(3);
  });

  test("catalog_pricing_current PK is (product_id, channel_id, locale)", async () => {
    const productId = randomUUID();
    const observedAt = new Date("2026-05-17T10:00:00Z");
    await db.insert(schema.catalogPricingCurrent).values({
      productId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      source: "shopify:connector",
      currency: "AUD",
      tiers: [{ kind: "list", amount: 10 }],
      primaryAmount: "10",
      observedAt
    });

    await expect(
      (async () => {
        await db.insert(schema.catalogPricingCurrent).values({
          productId,
          tenantId: TEST_TENANT_ID,
          channelId: TEST_CHANNEL_ID,
          source: "shopify:connector",
          currency: "AUD",
          tiers: [{ kind: "list", amount: 20 }],
          primaryAmount: "20",
          observedAt
        });
      })()
    ).rejects.toThrow(/duplicate key/i);
  });
});
