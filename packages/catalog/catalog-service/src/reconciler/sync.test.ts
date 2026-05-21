// Tests for the synchronous reconciler wrapper (plan §3.4, spec §13.4).
//
// These tests hit the real dev DB via @aonex/db/testing helpers. Each test
// seeds a catalog_products row scoped to TEST_TENANT_ID and seeds inline
// source_priority rules with a unique `actor` tag so cleanup is scoped and
// independent of the global Task 1.11 seed migration (which is not yet
// applied at the time of writing).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  TEST_MERCHANT_ID,
  TEST_TENANT_ID,
  closeTestDb,
  connectTestDb,
  ensureTestMerchant,
  ensureTestTenant
} from "@aonex/db/testing";
import { projectSync } from "./sync.js";
import { RECONCILER_VERSION } from "./pick-winner.js";

const TEST_ACTOR = "test:sync-reconciler";

// Inline observation constructor matching the values JSONB shape on disk
// (snake_case fields; ISO-8601 timestamps).
function obs(
  source: string,
  value: unknown,
  observedAtIso: string,
  overrides: Partial<{
    source_record_id: string;
    confidence: number;
  }> = {}
) {
  return {
    source,
    source_record_id: overrides.source_record_id ?? `${source}#1`,
    value,
    confidence: overrides.confidence ?? 1.0,
    observed_at: observedAtIso
  };
}

async function seedRules(db: DrizzleClient): Promise<void> {
  await db.insert(schema.sourcePriority).values([
    {
      tenantId: null,
      attributeCode: null,
      sourceGlob: "shopify:*",
      channelScope: "shopify-*",
      priority: 1,
      rulesVersion: 1,
      actor: TEST_ACTOR
    },
    {
      tenantId: null,
      attributeCode: null,
      sourceGlob: "ebay:*",
      channelScope: "ebay-*",
      priority: 2,
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

describe("projectSync (plan §3.4, spec §13.4)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    // Scoped cleanup — only rows owned by this test.
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.sourcePriority)
      .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
    await seedRules(db);
  });

  afterAll(async () => {
    await db
      .delete(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TEST_TENANT_ID));
    await db
      .delete(schema.sourcePriority)
      .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
    await closeTestDb();
  });

  test("1. projects winning_values for a sync-tier attribute", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "SYNC-001",
        identity: { brand: "Acme" },
        status: "active",
        values: {
          title: {
            "shopify-store-au": {
              en_AU: [
                obs("shopify:connector", "Shopify Title", "2026-05-01T00:00:00Z"),
                obs("ebay:link", "eBay Title", "2026-05-02T00:00:00Z")
              ]
            }
          }
        }
      })
      .returning();
    const productId = inserted[0]!.productId;

    const result = await projectSync({
      db,
      productId,
      affectedAttributes: ["title"],
      rulesVersion: 1
    });

    expect(result.productId).toBe(productId);
    expect(result.attributesProjected).toEqual(["title"]);
    expect(result.changedAttributes).toEqual(["title"]);

    const after = await db
      .select({ winningValues: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const wv = after[0]!.winningValues as Record<string, any>;

    // Shopify wins despite being older — its rule has higher priority on
    // shopify-* channel scope.
    expect(wv.title["shopify-store-au"].en_AU).toBe("Shopify Title");
  });

  test("2. idempotent — second run yields same winning_values and zero changes", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "SYNC-002",
        identity: { brand: "Acme" },
        status: "active",
        values: {
          title: {
            "shopify-store-au": {
              en_AU: [
                obs("shopify:connector", "T-Shopify", "2026-05-01T00:00:00Z"),
                obs("ebay:link", "T-Ebay", "2026-05-02T00:00:00Z")
              ]
            }
          }
        }
      })
      .returning();
    const productId = inserted[0]!.productId;

    const first = await projectSync({
      db,
      productId,
      affectedAttributes: ["title"],
      rulesVersion: 1
    });
    expect(first.changedAttributes).toEqual(["title"]);

    const afterFirst = await db
      .select({ winningValues: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const wv1 = afterFirst[0]!.winningValues as Record<string, any>;

    const second = await projectSync({
      db,
      productId,
      affectedAttributes: ["title"],
      rulesVersion: 1
    });
    expect(second.changedAttributes).toEqual([]);

    const afterSecond = await db
      .select({ winningValues: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const wv2 = afterSecond[0]!.winningValues as Record<string, any>;

    // The per-attribute winning values must be byte-identical between runs;
    // only `_meta.computed_at` is allowed to differ (fresh timestamp).
    expect(wv2.title).toEqual(wv1.title);
  });

  test("3. concurrent invocations serialize via advisory lock and both succeed", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "SYNC-003",
        identity: { brand: "Acme" },
        status: "active",
        values: {
          title: {
            "shopify-store-au": {
              en_AU: [
                obs("shopify:connector", "C-Shopify", "2026-05-01T00:00:00Z")
              ]
            }
          }
        }
      })
      .returning();
    const productId = inserted[0]!.productId;

    const [r1, r2] = await Promise.all([
      projectSync({
        db,
        productId,
        affectedAttributes: ["title"],
        rulesVersion: 1
      }),
      projectSync({
        db,
        productId,
        affectedAttributes: ["title"],
        rulesVersion: 1
      })
    ]);

    // Both calls succeed; the second is a no-op (lock released after the
    // first commits, then second reads the same winning_values and finds
    // nothing changed).
    expect(r1.productId).toBe(productId);
    expect(r2.productId).toBe(productId);

    const after = await db
      .select({ winningValues: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const wv = after[0]!.winningValues as Record<string, any>;
    expect(wv.title["shopify-store-au"].en_AU).toBe("C-Shopify");
  });

  test("4. skips attributes not present in values JSONB", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "SYNC-004",
        identity: { brand: "Acme" },
        status: "active",
        values: {
          title: {
            "shopify-store-au": {
              en_AU: [obs("shopify:connector", "T", "2026-05-01T00:00:00Z")]
            }
          }
        }
      })
      .returning();
    const productId = inserted[0]!.productId;

    const result = await projectSync({
      db,
      productId,
      affectedAttributes: ["title", "ghost_attribute"],
      rulesVersion: 1
    });

    expect(result.attributesProjected).toEqual(["title"]);
    expect(result.attributesProjected).not.toContain("ghost_attribute");
  });

  test("5. _meta block stamps reconciler_version + rules_version + computed_at", async () => {
    const inserted = await db
      .insert(schema.catalogProducts)
      .values({
        tenantId: TEST_TENANT_ID,
        merchantId: TEST_MERCHANT_ID,
        primaryIdentifier: "SYNC-005",
        identity: { brand: "Acme" },
        status: "active",
        values: {
          title: {
            "shopify-store-au": {
              en_AU: [obs("shopify:connector", "T", "2026-05-01T00:00:00Z")]
            }
          }
        }
      })
      .returning();
    const productId = inserted[0]!.productId;

    await projectSync({
      db,
      productId,
      affectedAttributes: ["title"],
      rulesVersion: 42
    });

    const after = await db
      .select({ winningValues: schema.catalogProducts.winningValues })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, productId));
    const wv = after[0]!.winningValues as Record<string, any>;
    const meta = wv._meta;

    expect(meta).toBeDefined();
    expect(meta.reconciler_version).toBe(RECONCILER_VERSION);
    expect(meta.rules_version).toBe(42);
    expect(typeof meta.computed_at).toBe("string");
    // computed_at must be a valid ISO-8601 timestamp.
    expect(Number.isNaN(Date.parse(meta.computed_at))).toBe(false);
  });
});
