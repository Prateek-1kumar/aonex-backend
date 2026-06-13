// Integration tests for the catalog_inventory schema (observations + current,
// partitioning, CHECK and coalesced-PK behavior) against a live Postgres.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { schema } from "../index.js";
import { connectTestDb, closeTestDb } from "../testing/connect.js";
import { ensureTestTenant, TEST_TENANT_ID } from "../testing/seed-tenant.js";
import { ensureTestMerchant } from "../testing/seed-merchant.js";
import { ensureTestChannel, TEST_CHANNEL_ID } from "../testing/seed-channel.js";
import {
  ensureTestInventoryLocation,
  TEST_LOCATION_ID
} from "../testing/seed-inventory-location.js";
import type { DrizzleClient } from "../client.js";

describe("catalog_inventory schema", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await ensureTestInventoryLocation(db);
    await db
      .delete(schema.catalogInventoryObservations)
      .where(eq(schema.catalogInventoryObservations.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.catalogInventoryCurrent)
      .where(eq(schema.catalogInventoryCurrent.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await db
      .delete(schema.catalogInventoryObservations)
      .where(eq(schema.catalogInventoryObservations.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.catalogInventoryCurrent)
      .where(eq(schema.catalogInventoryCurrent.tenantId, TEST_TENANT_ID));
    await closeTestDb();
  });

  test("accepts an inventory observation insert and auto-assigns observation_id + ingested_at", async () => {
    const productId = randomUUID();
    const observedAt = new Date("2026-05-15T10:00:00Z");
    const rows = await db
      .insert(schema.catalogInventoryObservations)
      .values({
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locationId: TEST_LOCATION_ID,
        qty: 42,
        clickCollectEligible: true,
        purchaseLimit: 5,
        backorderAllowed: false,
        source: "shopify:connector",
        sourceRecordId: "gid://shopify/InventoryLevel/123",
        observedAt
      })
      .returning();
    const row = rows[0]!;

    expect(row.observationId).toBeGreaterThan(0);
    expect(row.productId).toBe(productId);
    expect(row.tenantId).toBe(TEST_TENANT_ID);
    expect(row.channelId).toBe(TEST_CHANNEL_ID);
    expect(row.locationId).toBe(TEST_LOCATION_ID);
    expect(row.qty).toBe(42);
    expect(row.clickCollectEligible).toBe(true);
    expect(row.purchaseLimit).toBe(5);
    expect(row.backorderAllowed).toBe(false);
    expect(row.ingestedAt).toBeInstanceOf(Date);
  });

  test("app code inserts into catalog_inventory_current (no DB trigger)", async () => {
    const productId = randomUUID();
    const observedAt = new Date("2026-05-16T10:00:00Z");
    const rows = await db
      .insert(schema.catalogInventoryCurrent)
      .values({
        productId,
        tenantId: TEST_TENANT_ID,
        channelId: TEST_CHANNEL_ID,
        locationId: TEST_LOCATION_ID,
        qty: 17,
        source: "shopify:connector",
        observedAt
      })
      .returning();
    const row = rows[0]!;

    expect(row.productId).toBe(productId);
    expect(row.channelId).toBe(TEST_CHANNEL_ID);
    expect(row.locationId).toBe(TEST_LOCATION_ID);
    expect(row.qty).toBe(17);
    expect(row.source).toBe("shopify:connector");
  });

  test("(product_id, channel_id, location_id, observed_at DESC) index is used for latest-per-location lookup", async () => {
    const observedBase = new Date("2026-05-20T00:00:00Z").getTime();
    const productIds = Array.from({ length: 10 }, () => randomUUID());
    const bulkValues = Array.from({ length: 50 }, (_, i) => ({
      productId: productIds[i % productIds.length]!,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locationId: TEST_LOCATION_ID,
      qty: i,
      source: "shopify:connector",
      observedAt: new Date(observedBase + i * 60_000)
    }));

    await db.insert(schema.catalogInventoryObservations).values(bulkValues).execute();

    await db.execute(sql`ANALYZE catalog_inventory_observations`);
    await db.execute(sql`SET enable_seqscan = OFF`);

    const target = productIds[0]!;
    const plan = await db.execute(
      sql`EXPLAIN (FORMAT JSON)
          SELECT * FROM catalog_inventory_observations
          WHERE product_id = ${target}
            AND channel_id = ${TEST_CHANNEL_ID}
            AND location_id = ${TEST_LOCATION_ID}
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
      WHERE partrelid = 'catalog_inventory_observations'::regclass
    `);
    const row = result.rows[0]!;
    expect(row.partstrat).toBe("r");
  });

  test("monthly partitions exist for 2026-05, 2026-06, 2026-07", async () => {
    const result = await db.execute(sql`
      SELECT relname FROM pg_class
      WHERE relname IN (
        'catalog_inventory_observations_2026_05',
        'catalog_inventory_observations_2026_06',
        'catalog_inventory_observations_2026_07'
      )
      ORDER BY relname
    `);
    expect(result.rows.length).toBe(3);
  });

  test("CHECK (qty >= 0) rejects negative quantities", async () => {
    const productId = randomUUID();
    const observedAt = new Date("2026-05-18T10:00:00Z");
    await expect(
      (async () => {
        await db.insert(schema.catalogInventoryObservations).values({
          productId,
          tenantId: TEST_TENANT_ID,
          channelId: TEST_CHANNEL_ID,
          locationId: TEST_LOCATION_ID,
          qty: -1,
          source: "shopify:connector",
          observedAt
        });
      })()
    ).rejects.toThrow(/check constraint|qty/i);
  });

  test("NULL location_id rows are treated as duplicates via sentinel coalesce in PK", async () => {
    const productId = randomUUID();
    const observedAt = new Date("2026-05-19T10:00:00Z");
    await db.insert(schema.catalogInventoryCurrent).values({
      productId,
      tenantId: TEST_TENANT_ID,
      channelId: TEST_CHANNEL_ID,
      locationId: null,
      qty: 5,
      source: "shopify:connector",
      observedAt
    });

    await expect(
      (async () => {
        await db.insert(schema.catalogInventoryCurrent).values({
          productId,
          tenantId: TEST_TENANT_ID,
          channelId: TEST_CHANNEL_ID,
          locationId: null,
          qty: 9,
          source: "shopify:connector",
          observedAt
        });
      })()
    ).rejects.toThrow(/duplicate key/i);

    await db
      .delete(schema.catalogInventoryCurrent)
      .where(
        sql`${schema.catalogInventoryCurrent.productId} = ${productId} AND ${isNull(schema.catalogInventoryCurrent.locationId)}`
      );
  });
});
