import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { schema } from "../index.js";
import { connectTestDb, closeTestDb } from "../testing/connect.js";
import { ensureTestTenant, TEST_TENANT_ID } from "../testing/seed-tenant.js";
import { ensureTestMerchant, TEST_MERCHANT_ID } from "../testing/seed-merchant.js";
import type { DrizzleClient } from "../client.js";

describe("product_lineage schema", () => {
  let db: DrizzleClient;

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
    return rows[0]!.productId;
  }

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    // Scoped cleanup — lineage rows must go before catalog_products
    // since FKs have NO ACTION (would block delete).
    await db.execute(sql`
      DELETE FROM product_lineage
      WHERE product_id IN (
        SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
      )
      OR origin_product_id IN (
        SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
      )
    `);
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await db.execute(sql`
      DELETE FROM product_lineage
      WHERE product_id IN (
        SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
      )
      OR origin_product_id IN (
        SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
      )
    `);
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    await closeTestDb();
  });

  test("inserts a 'merge' event (split_filter NULL)", async () => {
    const productId = await seedProduct("PL-MERGE-INTO");
    const originProductId = await seedProduct("PL-MERGE-FROM");
    const rows = await db
      .insert(schema.productLineage)
      .values({
        productId,
        originProductId,
        operation: "merge",
        splitFilter: null,
        rationale: "Duplicate GTIN; merging A into B.",
        actor: "data-steward"
      })
      .returning();
    const row = rows[0]!;

    expect(row.lineageId).toBeGreaterThan(0);
    expect(row.productId).toBe(productId);
    expect(row.originProductId).toBe(originProductId);
    expect(row.operation).toBe("merge");
    expect(row.splitFilter).toBeNull();
    expect(row.rationale).toBe("Duplicate GTIN; merging A into B.");
    expect(row.actor).toBe("data-steward");
    expect(row.occurredAt).toBeInstanceOf(Date);
  });

  test("inserts a 'split' event with split_filter JSON populated", async () => {
    const productId = await seedProduct("PL-SPLIT-NEW");
    const originProductId = await seedProduct("PL-SPLIT-ORIG");
    const splitFilter = { color: "red", size: "L" };
    const rows = await db
      .insert(schema.productLineage)
      .values({
        productId,
        originProductId,
        operation: "split",
        splitFilter,
        rationale: "Variant split out as standalone product.",
        actor: "data-steward"
      })
      .returning();
    const row = rows[0]!;

    expect(row.lineageId).toBeGreaterThan(0);
    expect(row.operation).toBe("split");
    expect(row.splitFilter).toEqual(splitFilter);
    expect(row.rationale).toBe("Variant split out as standalone product.");
    expect(row.actor).toBe("data-steward");
    expect(row.occurredAt).toBeInstanceOf(Date);
  });

  test("inserts an 'unmerge' event (split_filter NULL, rationale populated)", async () => {
    const productId = await seedProduct("PL-UNMERGE-RESTORED");
    const originProductId = await seedProduct("PL-UNMERGE-PRIOR");
    const rows = await db
      .insert(schema.productLineage)
      .values({
        productId,
        originProductId,
        operation: "unmerge",
        splitFilter: null,
        rationale: "Earlier merge was incorrect — restoring original product.",
        actor: "data-steward"
      })
      .returning();
    const row = rows[0]!;

    expect(row.lineageId).toBeGreaterThan(0);
    expect(row.operation).toBe("unmerge");
    expect(row.splitFilter).toBeNull();
    expect(row.rationale).toBe(
      "Earlier merge was incorrect — restoring original product."
    );
    expect(row.actor).toBe("data-steward");
    expect(row.occurredAt).toBeInstanceOf(Date);
  });

  test("both named indexes exist on product_lineage", async () => {
    const result = await db.execute(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'product_lineage'
    `);
    const indexNames = result.rows.map((r: any) => r.indexname as string);
    expect(indexNames).toContain("idx_product_lineage_product");
    expect(indexNames).toContain("idx_product_lineage_origin");
  });
});
