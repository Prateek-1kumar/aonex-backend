// Integration tests for the channels + inventory_locations schema against a live Postgres.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "../index.js";
import { connectTestDb, closeTestDb } from "../testing/connect.js";
import { ensureTestTenant, TEST_TENANT_ID } from "../testing/seed-tenant.js";
import type { DrizzleClient } from "../client.js";

describe("channels schema", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await db.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.tenantId, TEST_TENANT_ID));
    await db.delete(schema.channels).where(eq(schema.channels.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await db.delete(schema.inventoryLocations).where(eq(schema.inventoryLocations.tenantId, TEST_TENANT_ID));
    await db.delete(schema.channels).where(eq(schema.channels.tenantId, TEST_TENANT_ID));
    await closeTestDb();
  });

  test("accepts a shopify channel row with default currency", async () => {
    const rows = await db
      .insert(schema.channels)
      .values({
        tenantId: TEST_TENANT_ID,
        channelKind: "shopify",
        region: "AU",
        accountRef: "demo-store.myshopify.com",
        defaultCurrency: "AUD",
        defaultLocale: "en_AU",
        displayName: "Demo Store (AU)"
      })
      .returning();
    const row = rows[0]!;

    expect(row.channelKind).toBe("shopify");
    expect(row.defaultCurrency).toBe("AUD");
    expect(row.region).toBe("AU");
    expect(row.channelId).toBeTruthy();
    expect(row.tenantId).toBe(TEST_TENANT_ID);
  });

  test("accepts an inventory_location row for a channel", async () => {
    const channelRows = await db
      .insert(schema.channels)
      .values({
        tenantId: TEST_TENANT_ID,
        channelKind: "amazon",
        region: "US",
        accountRef: "fba-seller-123",
        displayName: "FBA US"
      })
      .returning();
    const channel = channelRows[0]!;

    const locRows = await db
      .insert(schema.inventoryLocations)
      .values({
        channelId: channel.channelId,
        tenantId: TEST_TENANT_ID,
        kind: "fba",
        externalRef: "FBA_US_001",
        displayName: "FBA Warehouse US-East"
      })
      .returning();
    const loc = locRows[0]!;

    expect(loc.kind).toBe("fba");
    expect(loc.channelId).toBe(channel.channelId);
    expect(loc.locationId).toBeTruthy();
  });

  test("unique constraint blocks duplicate (tenant, kind, region, account_ref)", async () => {
    const duplicate = {
      tenantId: TEST_TENANT_ID,
      channelKind: "shopify",
      region: "AU",
      accountRef: "demo-store.myshopify.com",
      displayName: "Demo Store (AU) Duplicate"
    };

    await expect(
      db.insert(schema.channels).values(duplicate).returning().execute()
    ).rejects.toThrow();
  });

  test("unique constraint (NULLS NOT DISTINCT) blocks duplicate (tenant, kind, NULL, NULL)", async () => {
    const first = {
      tenantId: TEST_TENANT_ID,
      channelKind: "tiktok",
      region: null,
      accountRef: null,
      displayName: "TikTok (no region)"
    };
    const second = {
      tenantId: TEST_TENANT_ID,
      channelKind: "tiktok",
      region: null,
      accountRef: null,
      displayName: "TikTok (no region) Duplicate"
    };

    await db.insert(schema.channels).values(first).execute();

    await expect(
      db.insert(schema.channels).values(second).execute()
    ).rejects.toThrow();
  });
});
