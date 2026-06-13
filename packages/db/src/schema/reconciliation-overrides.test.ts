// Integration tests for the reconciliation_overrides schema against a live Postgres.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { schema } from "../index.js";
import { connectTestDb, closeTestDb } from "../testing/connect.js";
import { ensureTestTenant, TEST_TENANT_ID } from "../testing/seed-tenant.js";
import { ensureTestMerchant, TEST_MERCHANT_ID } from "../testing/seed-merchant.js";
import type { DrizzleClient } from "../client.js";

describe("reconciliation_overrides schema", () => {
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
    await db.execute(sql`
      DELETE FROM reconciliation_overrides
      WHERE product_id IN (
        SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
      )
    `);
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
  });

  afterAll(async () => {
    await db.execute(sql`
      DELETE FROM reconciliation_overrides
      WHERE product_id IN (
        SELECT product_id FROM catalog_products WHERE tenant_id = ${TEST_TENANT_ID}
      )
    `);
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    await closeTestDb();
  });

  test("inserts a permanent override (frozen_until NULL) — all 10 fields roundtrip", async () => {
    const productId = await seedProduct("RO-PERM-001");
    const rows = await db
      .insert(schema.reconciliationOverrides)
      .values({
        productId,
        attributeCode: "title",
        channelCode: "web",
        localeCode: "en_US",
        frozenValue: { value: "Pinned Title", unit: null },
        frozenUntil: null,
        actor: "merchant-ops",
        rationale: "Merchant requested permanent pin for SEO."
      })
      .returning();
    const row = rows[0]!;

    expect(row.overrideId).toBeGreaterThan(0);
    expect(row.productId).toBe(productId);
    expect(row.attributeCode).toBe("title");
    expect(row.channelCode).toBe("web");
    expect(row.localeCode).toBe("en_US");
    expect(row.frozenValue).toEqual({ value: "Pinned Title", unit: null });
    expect(row.frozenUntil).toBeNull();
    expect(row.actor).toBe("merchant-ops");
    expect(row.rationale).toBe("Merchant requested permanent pin for SEO.");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  test("inserts a time-bounded override (frozen_until set to a future date) — roundtrips", async () => {
    const productId = await seedProduct("RO-TIME-001");
    const frozenUntil = new Date("2027-01-01T00:00:00Z");
    const rows = await db
      .insert(schema.reconciliationOverrides)
      .values({
        productId,
        attributeCode: "description",
        channelCode: "amazon",
        frozenValue: { value: "Holiday season description" },
        frozenUntil,
        actor: "marketing",
        rationale: "Holiday campaign — restore upstream value after expiry."
      })
      .returning();
    const row = rows[0]!;

    expect(row.overrideId).toBeGreaterThan(0);
    expect(row.productId).toBe(productId);
    expect(row.attributeCode).toBe("description");
    expect(row.channelCode).toBe("amazon");
    expect(row.localeCode).toBe("_unscoped");
    expect(row.frozenValue).toEqual({ value: "Holiday season description" });
    expect(row.frozenUntil).toBeInstanceOf(Date);
    expect(row.frozenUntil!.toISOString()).toBe(frozenUntil.toISOString());
    expect(row.actor).toBe("marketing");
    expect(row.rationale).toBe("Holiday campaign — restore upstream value after expiry.");
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  test("ON DELETE CASCADE: deleting parent catalog_products row removes the override", async () => {
    const productId = await seedProduct("RO-CASCADE-001");
    await db.insert(schema.reconciliationOverrides).values({
      productId,
      attributeCode: "color",
      channelCode: "web",
      frozenValue: { value: "Red" },
      actor: "test",
      rationale: "cascade test"
    });

    const before = await db
      .select()
      .from(schema.reconciliationOverrides)
      .where(eq(schema.reconciliationOverrides.productId, productId));
    expect(before.length).toBe(1);

    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));

    const after = await db
      .select()
      .from(schema.reconciliationOverrides)
      .where(eq(schema.reconciliationOverrides.productId, productId));
    expect(after.length).toBe(0);
  });

  test("NOT NULL constraint: frozen_value rejected when missing", async () => {
    const productId = await seedProduct("RO-NN-001");
    await expect(
      (async () => {
        await db.execute(sql`
          INSERT INTO reconciliation_overrides
            (product_id, attribute_code, channel_code, actor, rationale)
          VALUES
            (${productId}, 'title', 'web', 'test', 'missing frozen_value')
        `);
      })()
    ).rejects.toThrow(/null value in column "frozen_value"|not-null/i);
  });
});
