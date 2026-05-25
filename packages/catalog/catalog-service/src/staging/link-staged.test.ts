// Integration tests for linkStagedProduct (Anomaly Lab Task 9, Part C).
//
// Uses the real DB. Unique tenant UUID to avoid collision with all other
// test files.
//
// Cases:
//   1. Happy path: stage a (possibly incomplete) product with matchCandidates
//      pointing to a live catalog_products row P, call linkStagedProduct →
//      result.productId === P, staged row status='promoted'.
//   2. Negative: confirmedProductId NOT in matchCandidates → throws.
//
// Channel seeding: mirrors promote-staged.test.ts. The staged item carries a
// pricing observation on "shopify-au". We seed a channel row with
// channelKind="shopify", region="au" so resolveChannelCodeToId derives
// "shopify-au" and maps to the channel ID.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  connectTestDb,
  closeTestDb,
  ensureTestMerchant,
  TEST_MERCHANT_ID
} from "@aonex/db/testing";
import type { TenantId, MerchantId, ChannelId } from "@aonex/types";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import { stageProduct } from "./stage-product.js";
import { evaluateGate } from "../gate/evaluate-gate.js";
import { linkStagedProduct } from "./link-staged.js";

// ---- Unique IDs for this test suite ----------------------------------------
// Never collide with:
//   TEST_TENANT_ID         "00000000-…-0001"  (catalog-write.test.ts)
//   STAGE_PRODUCT_TENANT   "b0000000-…-0099"  (stage-product.test.ts)
//   TENANT_ID              "c0000000-…-0099"  (admit-or-stage.test.ts)
//   FORCE_ID_TEST_TENANT   "ffffffff-…-0099"  (catalog-write.force-id.test.ts)
//   PROMOTE_TENANT_ID      "d0000000-…-0099"  (promote-staged.test.ts)
//   REJECT_TENANT_ID       "f0000000-…-0099"  (reject-staged.test.ts)

const LINK_TENANT_ID = "e0000000-0000-0000-0000-000000000099";
const LINK_MERCHANT_ID = TEST_MERCHANT_ID;
const LINK_CHANNEL_ID = "e0000000-0000-0000-0000-000000000098";
const LINK_CHANNEL_CODE = "shopify-au";    // matches channelKind=shopify, region=au
const LINK_DEDICATED_MERCHANT_ID = "e0000000-0000-0000-0000-000000000097";

const TENANT = LINK_TENANT_ID as unknown as TenantId;
const MERCHANT = LINK_MERCHANT_ID as unknown as MerchantId;
const CHANNEL = LINK_CHANNEL_ID as unknown as ChannelId;

const TEST_ACTOR = "test:link-staged";
const RESOLVER_ID = "e0000000-0000-0000-0000-000000000096";

// ---- Helpers ---------------------------------------------------------------

async function seedRules(db: DrizzleClient): Promise<void> {
  await db.insert(schema.sourcePriority).values({
    tenantId: null,
    attributeCode: null,
    sourceGlob: "*",
    channelScope: null,
    priority: 100,
    rulesVersion: 1,
    actor: TEST_ACTOR
  });
}

/**
 * Seed a minimal live catalog_products row. This is the "existing product P"
 * that the staged item will be linked onto. We insert it directly rather than
 * going through writeAdapterOutput to keep the test focused.
 *
 * primaryIdentifier must be unique per tenant. Use a per-test unique suffix to
 * allow multiple test cases in the same suite.
 */
async function seedLiveCatalogProduct(
  db: DrizzleClient,
  suffix: string
): Promise<string> {
  const [row] = await db
    .insert(schema.catalogProducts)
    .values({
      tenantId: LINK_TENANT_ID,
      merchantId: LINK_DEDICATED_MERCHANT_ID,
      primaryIdentifier: `link-test-product-${suffix}`,
      identity: { brand: "Acme", gtin: "p2000000000001" } as unknown,
      status: "active",
      values: {} as unknown
    })
    .returning({ productId: schema.catalogProducts.productId });
  if (!row) throw new Error("seedLiveCatalogProduct: insert returned no row");
  return row.productId;
}

/**
 * Create an AdapterOutput that is missing brand + identifier (gtin/mpn) but
 * HAS a pricing observation on LINK_CHANNEL_CODE. The gate will fail (missing
 * brand + identifier), which is intentional — linkStagedProduct must skip the
 * gate check because we are linking to a confirmed existing product.
 */
function incompleteAdapterOutputWithPricing(): AdapterOutput {
  return {
    observations: [
      {
        attributeCode: "title",
        target: "parent",
        channelCode: LINK_CHANNEL_CODE,
        localeCode: "en-AU",
        source: "shopify:connector",
        sourceRecordId: "rec-link-001",
        value: "Widget Hat",
        confidence: 0.95,
        observedAt: new Date("2026-05-25T10:00:00Z")
      },
      {
        attributeCode: "category_path",
        target: "parent",
        channelCode: LINK_CHANNEL_CODE,
        localeCode: "en-AU",
        source: "shopify:connector",
        sourceRecordId: "rec-link-001-cat",
        value: "Apparel > Accessories",
        confidence: 0.95,
        observedAt: new Date("2026-05-25T10:00:00Z")
      }
    ],
    pricingObservations: [
      {
        productHint: "widget-hat",
        channelCode: LINK_CHANNEL_CODE,
        locale: "en-AU",
        source: "shopify:connector",
        sourceRecordId: "rec-link-v001",
        currency: "AUD",
        tiers: [{ kind: "list", amount: 49.99 }],
        observedAt: new Date("2026-05-25T10:00:00Z")
      }
    ],
    inventoryObservations: [],
    identityHint: {
      // No brand, no gtin/mpn → gate fails → link must skip the gate
      targetIsVariant: false
    },
    rawPayload: { src: "link-staged-test" }
  };
}

/**
 * Stage the incomplete product with a matchCandidates entry pointing to
 * the given liveProductId.
 */
async function stageWithCandidate(
  db: DrizzleClient,
  liveProductId: string
): Promise<string> {
  const out = incompleteAdapterOutputWithPricing();
  const verdict = evaluateGate({ adapterOutput: out, signals: [] });
  if (verdict.admit) {
    throw new Error(
      "test setup error: incompleteAdapterOutputWithPricing should NOT pass the gate"
    );
  }
  const result = await stageProduct({
    db,
    tenantId: TENANT,
    merchantId: MERCHANT,
    adapterOutput: out,
    sourceKind: "shopify",
    channelCode: LINK_CHANNEL_CODE,
    verdict,
    matchCandidates: [{ productId: liveProductId, score: 0.6, kind: "live" }]
  });
  return result.stagedProductId;
}

async function cleanup(db: DrizzleClient): Promise<void> {
  // reconciliation_overrides (by product_id in this tenant)
  await db.execute(
    sql`
      DELETE FROM reconciliation_overrides
      WHERE product_id IN (
        SELECT product_id FROM catalog_products
        WHERE tenant_id = ${LINK_TENANT_ID}
      )
    `
  );

  // Staged products
  await db
    .delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.tenantId, LINK_TENANT_ID));

  // Side tables
  await db
    .delete(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.tenantId, LINK_TENANT_ID));
  await db
    .delete(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.tenantId, LINK_TENANT_ID));
  await db.execute(
    sql`DELETE FROM catalog_events WHERE tenant_id = ${LINK_TENANT_ID}`
  );

  // Revisions (immutable trigger)
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`
  );
  await db
    .delete(schema.catalogProductRevisions)
    .where(eq(schema.catalogProductRevisions.tenantId, LINK_TENANT_ID));
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`
  );

  // Identity side-effects
  await db
    .delete(schema.identityLog)
    .where(eq(schema.identityLog.tenantId, LINK_TENANT_ID));
  await db
    .delete(schema.reviewTasks)
    .where(eq(schema.reviewTasks.tenantId, LINK_TENANT_ID));

  // Catalog products
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, LINK_TENANT_ID));

  // Channel seeded for this suite
  await db
    .delete(schema.channels)
    .where(eq(schema.channels.channelId, LINK_CHANNEL_ID));

  // Source priority rules
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));

  // Dedicated merchant
  await db
    .delete(schema.merchants)
    .where(eq(schema.merchants.id, LINK_DEDICATED_MERCHANT_ID));

  // Tenant
  await db
    .delete(schema.tenants)
    .where(eq(schema.tenants.id, LINK_TENANT_ID));
}

// ---- Suite setup -----------------------------------------------------------

describe("linkStagedProduct (Task 9 Part C)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();

    // Seed tenant
    await db
      .insert(schema.tenants)
      .values({
        id: LINK_TENANT_ID,
        name: "Test Tenant (link-staged)",
        status: "active"
      })
      .onConflictDoNothing();

    // Ensure shared merchant exists
    await ensureTestMerchant(db);

    // Seed a dedicated merchant for this tenant
    await db
      .insert(schema.merchants)
      .values({
        id: LINK_DEDICATED_MERCHANT_ID,
        tenantId: LINK_TENANT_ID,
        email: "test-link-staged@link-staged-tests.internal",
        passwordHash: "$2b$10$placeholder-hash-for-schema-tests-only",
        displayName: "Test Merchant (link-staged)",
        defaultCurrency: "AUD"
      })
      .onConflictDoNothing();

    // Seed channel: channelKind=shopify, region=au → resolveChannelCodeToId
    // derives "shopify-au" and maps to LINK_CHANNEL_ID.
    await db
      .insert(schema.channels)
      .values({
        channelId: LINK_CHANNEL_ID,
        tenantId: LINK_TENANT_ID,
        channelKind: "shopify",
        region: "au",
        accountRef: "link-staged-tests",
        defaultCurrency: "AUD",
        defaultLocale: "en-AU",
        displayName: "Test Channel (link-staged)"
      })
      .onConflictDoNothing();

    await cleanup(db);

    // Re-seed after cleanup wipes them
    await db
      .insert(schema.tenants)
      .values({
        id: LINK_TENANT_ID,
        name: "Test Tenant (link-staged)",
        status: "active"
      })
      .onConflictDoNothing();
    await db
      .insert(schema.merchants)
      .values({
        id: LINK_DEDICATED_MERCHANT_ID,
        tenantId: LINK_TENANT_ID,
        email: "test-link-staged@link-staged-tests.internal",
        passwordHash: "$2b$10$placeholder-hash-for-schema-tests-only",
        displayName: "Test Merchant (link-staged)",
        defaultCurrency: "AUD"
      })
      .onConflictDoNothing();
    await db
      .insert(schema.channels)
      .values({
        channelId: LINK_CHANNEL_ID,
        tenantId: LINK_TENANT_ID,
        channelKind: "shopify",
        region: "au",
        accountRef: "link-staged-tests",
        defaultCurrency: "AUD",
        defaultLocale: "en-AU",
        displayName: "Test Channel (link-staged)"
      })
      .onConflictDoNothing();

    await seedRules(db);
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  // ---- Happy path -----------------------------------------------------------
  test("1. links a staged product onto an existing live product: result.productId === P, status='promoted'", async () => {
    const liveProductId = await seedLiveCatalogProduct(db, "happy");
    const stagedProductId = await stageWithCandidate(db, liveProductId);

    // Call linkStagedProduct — empty fills is fine (linking to a complete product)
    const result = await linkStagedProduct({
      db,
      tenantId: TENANT,
      stagedProductId,
      confirmedProductId: liveProductId,
      resolvedBy: RESOLVER_ID,
      fills: {}
    });

    // ---- result.productId must equal the existing live product P --------------
    expect(result.productId).toBe(liveProductId);

    // ---- staged row must be 'promoted' ---------------------------------------
    const stagedRows = await db
      .select()
      .from(schema.stagedProducts)
      .where(eq(schema.stagedProducts.stagedProductId, stagedProductId));
    expect(stagedRows.length).toBe(1);
    expect(stagedRows[0]!.status).toBe("promoted");
    expect(stagedRows[0]!.resolvedBy).toBe(RESOLVER_ID);
  });

  // ---- Negative: confirmedProductId not in matchCandidates -----------------
  test("2. confirmedProductId not in matchCandidates throws", async () => {
    const liveProductId = await seedLiveCatalogProduct(db, "negative");
    // Stage with an empty matchCandidates (NOT pointing at liveProductId)
    const out = incompleteAdapterOutputWithPricing();
    const verdict = evaluateGate({ adapterOutput: out, signals: [] });
    const { stagedProductId } = await stageProduct({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: out,
      sourceKind: "shopify",
      channelCode: LINK_CHANNEL_CODE,
      verdict,
      matchCandidates: []  // empty — no candidates
    });

    let thrown: unknown;
    try {
      await linkStagedProduct({
        db,
        tenantId: TENANT,
        stagedProductId,
        confirmedProductId: liveProductId,  // not in candidates
        resolvedBy: RESOLVER_ID,
        fills: {}
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("is not a candidate");
  });
});
