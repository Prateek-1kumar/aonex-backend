import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { schema } from "../index.js";
import { connectTestDb, closeTestDb } from "../testing/connect.js";
import { ensureTestTenant, TEST_TENANT_ID } from "../testing/seed-tenant.js";
import { ensureTestMerchant, TEST_MERCHANT_ID } from "../testing/seed-merchant.js";
import type { DrizzleClient } from "../client.js";

describe("identity_log schema", () => {
  let db: DrizzleClient;
  let seededProductIds: string[] = [];

  async function seedProduct(primaryIdentifier: string): Promise<string> {
    const rows = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier,
        identity: { brand: "TestBrand" },
        status: "active",
        values: {}
      })
      .returning();
    const productId = rows[0]!.productId;
    seededProductIds.push(productId);
    return productId;
  }

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    // Scoped cleanup — tenant-only.
    await db
      .delete(schema.identityLog)
      .where(eq(schema.identityLog.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await db
      .delete(schema.identityLog)
      .where(eq(schema.identityLog.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    await closeTestDb();
  });

  test("inserts a 'set' event (old_value NULL, new_value present)", async () => {
    const productId = await seedProduct("IDLOG-SET-001");
    const observedAt = new Date("2026-05-15T10:00:00Z");
    const rows = await db
      .insert(schema.identityLog)
      .values({
        productId,
        tenantId: TEST_TENANT_ID,
        identityField: "gtin",
        oldValue: null,
        newValue: "00012345678905",
        source: "shopify:connector",
        sourceRecordId: "gid://shopify/Product/123",
        observedAt
      })
      .returning();
    const row = rows[0]!;

    expect(row.logId).toBeGreaterThan(0);
    expect(row.productId).toBe(productId);
    expect(row.tenantId).toBe(TEST_TENANT_ID);
    expect(row.identityField).toBe("gtin");
    expect(row.oldValue).toBeNull();
    expect(row.newValue).toBe("00012345678905");
    expect(row.source).toBe("shopify:connector");
    expect(row.sourceRecordId).toBe("gid://shopify/Product/123");
    expect(row.observedAt).toBeInstanceOf(Date);
    expect(row.appliedAt).toBeInstanceOf(Date);
    expect(row.rationale).toBeNull();
  });

  test("inserts a 'change' event (old + new + rationale) — roundtrips all 12 fields", async () => {
    const productId = await seedProduct("IDLOG-CHG-001");
    const observedAt = new Date("2026-05-16T11:30:00Z");
    const rows = await db
      .insert(schema.identityLog)
      .values({
        productId,
        tenantId: TEST_TENANT_ID,
        identityField: "mpn",
        oldValue: "OLD-MPN-001",
        newValue: "NEW-MPN-001",
        source: "salsify:feed",
        sourceRecordId: "salsify-record-42",
        observedAt,
        rationale: "Manufacturer renumbered SKU; salsify feed authoritative for mpn."
      })
      .returning();
    const row = rows[0]!;

    expect(row.logId).toBeGreaterThan(0);
    expect(row.productId).toBe(productId);
    expect(row.tenantId).toBe(TEST_TENANT_ID);
    expect(row.identityField).toBe("mpn");
    expect(row.oldValue).toBe("OLD-MPN-001");
    expect(row.newValue).toBe("NEW-MPN-001");
    expect(row.source).toBe("salsify:feed");
    expect(row.sourceRecordId).toBe("salsify-record-42");
    expect(row.observedAt.toISOString()).toBe(observedAt.toISOString());
    expect(row.appliedAt).toBeInstanceOf(Date);
    expect(row.rationale).toBe(
      "Manufacturer renumbered SKU; salsify feed authoritative for mpn."
    );
  });

  test("inserts a 'clear' event (old_value present, new_value NULL) — NULL new_value preserved", async () => {
    const productId = await seedProduct("IDLOG-CLR-001");
    const observedAt = new Date("2026-05-17T09:00:00Z");
    const rows = await db
      .insert(schema.identityLog)
      .values({
        productId,
        tenantId: TEST_TENANT_ID,
        identityField: "brand",
        oldValue: "DiscontinuedBrand",
        newValue: null,
        source: "akeneo:connector",
        observedAt,
        rationale: "Brand attribute cleared upstream."
      })
      .returning();
    const row = rows[0]!;

    expect(row.identityField).toBe("brand");
    expect(row.oldValue).toBe("DiscontinuedBrand");
    expect(row.newValue).toBeNull();
    expect(row.source).toBe("akeneo:connector");
    expect(row.sourceRecordId).toBeNull();
  });

  test("FK constraint: insert with unknown product_id is rejected", async () => {
    const bogusProductId = randomUUID();
    await expect(
      (async () => {
        await db.insert(schema.identityLog).values({
          productId: bogusProductId,
          tenantId: TEST_TENANT_ID,
          identityField: "gtin",
          newValue: "00099999999999",
          source: "shopify:connector",
          observedAt: new Date("2026-05-18T00:00:00Z")
        });
      })()
    ).rejects.toThrow(/foreign key|violates foreign key constraint/i);
  });

  test("NOT NULL constraint: identity_field rejected when missing", async () => {
    const productId = await seedProduct("IDLOG-NN-001");
    await expect(
      (async () => {
        await db.execute(sql`
          INSERT INTO identity_log (product_id, tenant_id, source, observed_at)
          VALUES (${productId}, ${TEST_TENANT_ID}, 'shopify:connector', '2026-05-19T00:00:00Z'::timestamptz)
        `);
      })()
    ).rejects.toThrow(/null value in column "identity_field"|not-null/i);
  });
});
