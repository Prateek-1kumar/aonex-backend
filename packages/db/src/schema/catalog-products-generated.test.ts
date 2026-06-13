// Integration tests for catalog_products generated columns (gen_brand, gen_gtin,
// gen_title, gen_primary_price/currency, gen_inventory_total) against a live Postgres.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { schema } from "../index.js";
import { connectTestDb, closeTestDb } from "../testing/connect.js";
import { ensureTestTenant, TEST_TENANT_ID } from "../testing/seed-tenant.js";
import { ensureTestMerchant, TEST_MERCHANT_ID } from "../testing/seed-merchant.js";
import type { DrizzleClient } from "../client.js";

describe("catalog_products generated columns", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    await closeTestDb();
  });

  test("gen_brand and gen_gtin are populated from identity column", async () => {
    const rows = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "GEN-BRAND-001",
        identity: { brand: "Nike", gtin: "012345" },
        status: "draft",
        values: {}
      })
      .returning();
    const row = rows[0]!;

    const result = await db.execute(
      sql`SELECT gen_brand, gen_gtin FROM catalog_products WHERE product_id = ${row.productId}`
    );
    const fetched = result.rows[0]!;

    expect(fetched.gen_brand).toBe("Nike");
    expect(fetched.gen_gtin).toBe("012345");
  });

  test("gen_title is populated from winning_values column", async () => {
    const rows = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "GEN-TITLE-001",
        identity: { brand: "Adidas" },
        status: "draft",
        values: {},
        winningValues: { title: { _primary: { value: "Hello" } } }
      })
      .returning();
    const row = rows[0]!;

    const result = await db.execute(
      sql`SELECT gen_title FROM catalog_products WHERE product_id = ${row.productId}`
    );
    const fetched = result.rows[0]!;

    expect(fetched.gen_title).toBe("Hello");
  });

  test("gen_primary_price and gen_primary_currency are populated from winning_values", async () => {
    const rows = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "GEN-PRICE-001",
        identity: { brand: "Puma" },
        status: "draft",
        values: {},
        winningValues: {
          pricing: { _primary: { currency: "USD", tiers: [{ amount: "29.99" }] } }
        }
      })
      .returning();
    const row = rows[0]!;

    const result = await db.execute(
      sql`SELECT gen_primary_currency, gen_primary_price FROM catalog_products WHERE product_id = ${row.productId}`
    );
    const fetched = result.rows[0]!;

    expect(fetched.gen_primary_currency).toBe("USD");
    expect(Number(fetched.gen_primary_price)).toBeCloseTo(29.99);
  });

  test("gen_inventory_total is populated from winning_values", async () => {
    const rows = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "GEN-INV-001",
        identity: { brand: "Reebok" },
        status: "draft",
        values: {},
        winningValues: {
          inventory: { _primary: { total: "42" } }
        }
      })
      .returning();
    const row = rows[0]!;

    const result = await db.execute(
      sql`SELECT gen_inventory_total FROM catalog_products WHERE product_id = ${row.productId}`
    );
    const fetched = result.rows[0]!;

    expect(Number(fetched.gen_inventory_total)).toBe(42);
  });

  test("brand filter uses idx_catalog_products_gen_brand index", async () => {
    const brandNames = [
      "Alpha", "Beta", "Gamma", "Delta", "Epsilon",
      "Zeta", "Eta", "Theta", "Iota", "Kappa"
    ];
    const bulkValues = Array.from({ length: 50 }, (_, i) => ({
      tenantId: TEST_TENANT_ID,
      merchantId: TEST_MERCHANT_ID,
      primaryIdentifier: `BRAND-BULK-${i.toString().padStart(3, "0")}`,
      identity: { brand: brandNames[i % brandNames.length]! },
      status: "draft" as const,
      values: {}
    }));

    await db.insert(schema.catalogProducts).values(bulkValues).execute();

    await db.execute(sql`ANALYZE catalog_products`);

    await db.execute(sql`SET enable_seqscan = OFF`);

    const plan = await db.execute(
      sql`EXPLAIN (FORMAT JSON) SELECT * FROM catalog_products WHERE gen_brand = 'Alpha'`
    );

    await db.execute(sql`SET enable_seqscan = ON`);

    const planJson = JSON.stringify(plan.rows);
    expect(planJson).toContain("idx_catalog_products_gen_brand");
  });
});
