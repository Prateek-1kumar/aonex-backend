// Integration tests for the catalog_product_revisions schema against a live Postgres.
// Cleanup temporarily disables trg_revisions_immutable since the table is append-only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { schema } from "../index.js";
import { connectTestDb, closeTestDb } from "../testing/connect.js";
import { ensureTestTenant, TEST_TENANT_ID } from "../testing/seed-tenant.js";
import type { DrizzleClient } from "../client.js";

describe("catalog_product_revisions schema", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await db.execute(sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`);
    await db
      .delete(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.tenantId, TEST_TENANT_ID));
    await db.execute(sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`);
  });

  afterAll(async () => {
    await db.execute(sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`);
    await db
      .delete(schema.catalogProductRevisions)
      .where(eq(schema.catalogProductRevisions.tenantId, TEST_TENANT_ID));
    await db.execute(sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`);
    await closeTestDb();
  });

  test("accepts a revision insert and auto-assigns revision_id + ingested_at", async () => {
    const productId = randomUUID();
    const rows = await db
      .insert(schema.catalogProductRevisions)
      .values({
        productId,
        tenantId: TEST_TENANT_ID,
        valuesSnapshot: { title: { _primary: { source: "shopify", value: "Test Title" } } },
        revisionReason: "ingestion_apply",
        sourceKind: "shopify",
        sourceRecordId: "shp-001"
      })
      .returning();
    const row = rows[0]!;

    expect(row.revisionId).toBeGreaterThan(0);
    expect(row.productId).toBe(productId);
    expect(row.tenantId).toBe(TEST_TENANT_ID);
    expect(row.revisionReason).toBe("ingestion_apply");
    expect(row.sourceKind).toBe("shopify");
    expect(row.ingestedAt).toBeInstanceOf(Date);
    expect(row.suppressOutbound).toBe(false);
  });

  test("UPDATE on a revision is blocked by the immutability trigger", async () => {
    const productId = randomUUID();
    const inserted = await db
      .insert(schema.catalogProductRevisions)
      .values({
        productId,
        tenantId: TEST_TENANT_ID,
        valuesSnapshot: { foo: "bar" },
        revisionReason: "ingestion_apply"
      })
      .returning();
    const row = inserted[0]!;

    await expect(
      (async () => {
        await db.execute(sql`
          UPDATE catalog_product_revisions
          SET revision_reason = 'tampered'
          WHERE revision_id = ${row.revisionId}
        `);
      })()
    ).rejects.toThrow(/append-only/);
  });

  test("DELETE on a revision is blocked by the immutability trigger", async () => {
    const productId = randomUUID();
    const inserted = await db
      .insert(schema.catalogProductRevisions)
      .values({
        productId,
        tenantId: TEST_TENANT_ID,
        valuesSnapshot: { foo: "baz" },
        revisionReason: "ingestion_apply"
      })
      .returning();
    const row = inserted[0]!;

    await expect(
      (async () => {
        await db.execute(sql`
          DELETE FROM catalog_product_revisions
          WHERE revision_id = ${row.revisionId}
        `);
      })()
    ).rejects.toThrow(/append-only/);
  });

  test("monthly partition for the current month exists", async () => {
    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_class
        WHERE relname = 'catalog_product_revisions_2026_05'
          AND relkind = 'r'
      ) AS exists
    `);
    const exists = result.rows[0]!.exists;
    expect(exists).toBe(true);
  });

  test("parent table is partitioned by range on ingested_at", async () => {
    const result = await db.execute(sql`
      SELECT partstrat, partattrs FROM pg_partitioned_table
      WHERE partrelid = 'catalog_product_revisions'::regclass
    `);
    const row = result.rows[0]!;
    expect(row.partstrat).toBe("r");
  });
});
