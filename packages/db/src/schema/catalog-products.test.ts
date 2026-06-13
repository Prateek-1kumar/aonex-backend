// Integration tests for the catalog_products schema against a live Postgres.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "../index.js";
import { connectTestDb, closeTestDb } from "../testing/connect.js";
import { ensureTestTenant, TEST_TENANT_ID } from "../testing/seed-tenant.js";
import { ensureTestMerchant, TEST_MERCHANT_ID } from "../testing/seed-merchant.js";
import type { DrizzleClient } from "../client.js";

describe("catalog_products schema", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await db.delete(schema.catalogProducts).where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await db.delete(schema.catalogProducts).where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    await closeTestDb();
  });

  test("accepts a minimal product row", async () => {
    const rows = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "TEST-SKU-001",
        identity: { brand: "Nike", identityStrength: 1.0 },
        status: "draft",
        values: {}
      })
      .returning();
    const row = rows[0]!;

    expect(row.primaryIdentifier).toBe("TEST-SKU-001");
    expect(row.values).toEqual({});
    expect(row.productId).toBeTruthy();
    expect(row.tenantId).toBe(TEST_TENANT_ID);
    expect(row.merchantId).toBe(TEST_MERCHANT_ID);
    expect(row.status).toBe("draft");
  });

  test("unique (tenant_id, primary_identifier) prevents duplicates", async () => {
    await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "DUPE-SKU-001",
        identity: { brand: "Adidas" },
        status: "draft",
        values: {}
      })
      .execute();

    await expect(
      db
        .insert(schema.catalogProducts)
        .values({
          tenantId: TEST_TENANT_ID,
          merchantId: TEST_MERCHANT_ID,
          primaryIdentifier: "DUPE-SKU-001",
          identity: { brand: "Adidas" },
          status: "draft",
          values: {}
        })
        .execute()
    ).rejects.toThrow();
  });

  test("parent_product_id self-reference works for variants", async () => {
    const parentRows = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "PARENT-SKU-001",
        identity: { brand: "Puma" },
        status: "active",
        values: {}
      })
      .returning();
    const parent = parentRows[0]!;

    const variantRows = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "VARIANT-SKU-001",
        identity: { brand: "Puma" },
        status: "active",
        parentProductId: parent.productId,
        values: { color: "red", size: "M" }
      })
      .returning();
    const variant = variantRows[0]!;

    expect(variant.parentProductId).toBe(parent.productId);
    expect(variant.values).toEqual({ color: "red", size: "M" });
  });

  test("merged_into_product_id can be set for tombstones", async () => {
    const targetRows = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "MERGE-TARGET-001",
        identity: { brand: "Reebok" },
        status: "active",
        values: {}
      })
      .returning();
    const target = targetRows[0]!;

    const tombstoneRows = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "MERGE-TOMBSTONE-001",
        identity: { brand: "Reebok" },
        status: "merged",
        mergedIntoProductId: target.productId,
        values: {}
      })
      .returning();
    const tombstone = tombstoneRows[0]!;

    expect(tombstone.mergedIntoProductId).toBe(target.productId);
    expect(tombstone.status).toBe("merged");
  });
});
