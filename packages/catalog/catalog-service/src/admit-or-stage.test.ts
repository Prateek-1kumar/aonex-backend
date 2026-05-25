// Integration tests for the admitOrStage chokepoint (Anomaly Lab Task 5).
//
// Three routing cases:
//   1. New + complete AdapterOutput  → admitted   (productId set, stagedProductId null)
//   2. New + incomplete              → staged     (productId null, stagedProductId set)
//   3. Incomplete re-ingest of a live product → enriched (productId set, not staged)
//
// Uses a unique tenant UUID to avoid collision with catalog-write.test.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  closeTestDb,
  connectTestDb
} from "@aonex/db/testing";
import type { ChannelId, MerchantId, TenantId } from "@aonex/types";
import type { AdapterOutput, CanonicalObservation, PricingObservation } from "@aonex/catalog-source-adapters";
import { admitOrStage } from "./admit-or-stage.js";

// ---- Unique IDs for this test suite (never collide with catalog-write.test.ts) ----
const TENANT_ID = "c0000000-0000-0000-0000-000000000099";
const MERCHANT_ID = "c0000000-0000-0000-0000-000000000098";
const CHANNEL_ID = "c0000000-0000-0000-0000-000000000097";
const CHANNEL_CODE = "shopify-au";

const TENANT = TENANT_ID as unknown as TenantId;
const MERCHANT = MERCHANT_ID as unknown as MerchantId;
const CHANNEL = CHANNEL_ID as unknown as ChannelId;

const TEST_ACTOR = "test:admit-or-stage";

// ---- Helpers -------------------------------------------------------------------

function obs(overrides: Partial<CanonicalObservation> = {}): CanonicalObservation {
  return {
    attributeCode: "title",
    target: "parent",
    channelCode: CHANNEL_CODE,
    localeCode: "en_AU",
    source: "shopify:connector",
    sourceRecordId: "gid://shopify/Product/1",
    value: "Test Widget",
    confidence: 0.95,
    observedAt: new Date("2026-05-25T10:00:00Z"),
    ...overrides
  };
}

function pricingObs(overrides: Partial<PricingObservation> = {}): PricingObservation {
  return {
    productHint: "p1",
    channelCode: CHANNEL_CODE,
    locale: "en_AU",
    source: "shopify:connector",
    sourceRecordId: "gid://shopify/ProductVariant/1",
    currency: "AUD",
    tiers: [{ kind: "list", amount: 49.95 }],
    observedAt: new Date("2026-05-25T10:00:00Z"),
    ...overrides
  };
}

/** A complete AdapterOutput that passes the CANONICAL_MINIMUM gate. */
function completeOutput(gtin: string, sourceRecordSuffix: string): AdapterOutput {
  return {
    observations: [
      obs({
        attributeCode: "title",
        value: "Acme Gate Test Widget",
        sourceRecordId: `gid://shopify/Product/${sourceRecordSuffix}`
      }),
      obs({
        attributeCode: "category_path",
        value: "Electronics > Widgets",
        sourceRecordId: `gid://shopify/Product/${sourceRecordSuffix}-cat`
      })
    ],
    pricingObservations: [
      pricingObs({
        sourceRecordId: `gid://shopify/ProductVariant/${sourceRecordSuffix}`
      })
    ],
    inventoryObservations: [],
    identityHint: {
      gtin,
      brand: "Acme",
      targetIsVariant: false
    },
    rawPayload: { src: "admit-or-stage-test" }
  };
}

/** An incomplete AdapterOutput — missing brand+gtin so gate fails. */
function incompleteOutput(sourceRecordSuffix: string): AdapterOutput {
  return {
    observations: [
      obs({
        attributeCode: "title",
        value: "Incomplete Widget",
        sourceRecordId: `gid://shopify/Product/${sourceRecordSuffix}`
      })
      // Missing: category_path
    ],
    pricingObservations: [],
    inventoryObservations: [],
    identityHint: {
      // No gtin, no mpn → fails identifier check
      // No brand → fails brand check
      targetIsVariant: false
    },
    rawPayload: { src: "admit-or-stage-test-incomplete" }
  };
}

/** An incomplete output but with a known GTIN (for the "enriched" case). */
function incompleteWithGtin(gtin: string, sourceRecordSuffix: string): AdapterOutput {
  return {
    observations: [
      obs({
        attributeCode: "title",
        value: "Enrichment Widget",
        sourceRecordId: `gid://shopify/Product/${sourceRecordSuffix}`
      })
      // Missing: category_path (so gate would normally block)
      // Missing: pricing (so gate would normally block)
    ],
    pricingObservations: [],
    inventoryObservations: [],
    identityHint: {
      gtin,
      brand: "Acme",
      targetIsVariant: false
    },
    rawPayload: { src: "admit-or-stage-test-enrich" }
  };
}

// ---- Cleanup -------------------------------------------------------------------

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

async function cleanup(db: DrizzleClient): Promise<void> {
  // Staged products (no FK dependency on catalog_products)
  await db
    .delete(schema.stagedProducts)
    .where(eq(schema.stagedProducts.tenantId, TENANT_ID));

  // Side tables
  await db
    .delete(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.tenantId, TENANT_ID));
  await db
    .delete(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.tenantId, TENANT_ID));
  await db.execute(
    sql`DELETE FROM catalog_events WHERE tenant_id = ${TENANT_ID}`
  );

  // Revisions (immutable trigger must be disabled around test-tenant scrub)
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`
  );
  await db
    .delete(schema.catalogProductRevisions)
    .where(eq(schema.catalogProductRevisions.tenantId, TENANT_ID));
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`
  );

  // Identity side-effects
  await db
    .delete(schema.identityLog)
    .where(eq(schema.identityLog.tenantId, TENANT_ID));
  await db
    .delete(schema.reviewTasks)
    .where(eq(schema.reviewTasks.tenantId, TENANT_ID));

  // Catalog products
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, TENANT_ID));

  // Channel seeded for this suite
  await db
    .delete(schema.channels)
    .where(eq(schema.channels.channelId, CHANNEL_ID));

  // Source priority rules seeded for this suite
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));

  // Merchant then tenant (FK order: merchant → tenant)
  await db
    .delete(schema.merchants)
    .where(eq(schema.merchants.id, MERCHANT_ID));
  await db
    .delete(schema.tenants)
    .where(eq(schema.tenants.id, TENANT_ID));
}

// ---- Suite setup ---------------------------------------------------------------

describe("admitOrStage — routing chokepoint", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();

    // Seed tenant
    await db
      .insert(schema.tenants)
      .values({ id: TENANT_ID, name: "Test Tenant (admit-or-stage)", status: "active" })
      .onConflictDoNothing();

    // Seed merchant (unique email to avoid collision)
    await db
      .insert(schema.merchants)
      .values({
        id: MERCHANT_ID,
        tenantId: TENANT_ID,
        email: "test-admit-or-stage@admit-or-stage-tests.internal",
        passwordHash: "$2b$10$placeholder-hash-for-schema-tests-only",
        displayName: "Test Merchant (admit-or-stage)",
        defaultCurrency: "AUD"
      })
      .onConflictDoNothing();

    // Seed channel — matches CHANNEL_CODE so channelCodeToId can resolve
    await db
      .insert(schema.channels)
      .values({
        channelId: CHANNEL_ID,
        tenantId: TENANT_ID,
        channelKind: "shopify",
        region: "au",
        accountRef: "admit-or-stage-tests",
        defaultCurrency: "AUD",
        defaultLocale: "en_AU",
        displayName: "Test Channel (admit-or-stage)"
      })
      .onConflictDoNothing();

    // Start clean, then seed rules
    await cleanup(db);
    // Re-seed tenant/merchant/channel after cleanup wipes them
    await db
      .insert(schema.tenants)
      .values({ id: TENANT_ID, name: "Test Tenant (admit-or-stage)", status: "active" })
      .onConflictDoNothing();
    await db
      .insert(schema.merchants)
      .values({
        id: MERCHANT_ID,
        tenantId: TENANT_ID,
        email: "test-admit-or-stage@admit-or-stage-tests.internal",
        passwordHash: "$2b$10$placeholder-hash-for-schema-tests-only",
        displayName: "Test Merchant (admit-or-stage)",
        defaultCurrency: "AUD"
      })
      .onConflictDoNothing();
    await db
      .insert(schema.channels)
      .values({
        channelId: CHANNEL_ID,
        tenantId: TENANT_ID,
        channelKind: "shopify",
        region: "au",
        accountRef: "admit-or-stage-tests",
        defaultCurrency: "AUD",
        defaultLocale: "en_AU",
        displayName: "Test Channel (admit-or-stage)"
      })
      .onConflictDoNothing();
    await seedRules(db);
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  // ---- Case 1: new + complete → admitted -------------------------------------
  test("1. new + complete AdapterOutput → outcome=admitted, productId set", async () => {
    const gtin = "c1000000000001";
    const result = await admitOrStage({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: completeOutput(gtin, "AOS-1"),
      sourceKind: "shopify",
      actor: TEST_ACTOR,
      channelCode: CHANNEL_CODE,
      channelCodeToId: { [CHANNEL_CODE]: CHANNEL }
    });

    expect(result.outcome).toBe("admitted");
    expect(result.productId).not.toBeNull();
    expect(typeof result.productId).toBe("string");
    expect(result.stagedProductId).toBeNull();

    // Verify it landed in catalog_products
    const rows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TENANT_ID));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.productId === result.productId)).toBe(true);
  });

  // ---- Case 2: new + incomplete → staged ------------------------------------
  test("2. new + incomplete AdapterOutput → outcome=staged, stagedProductId set", async () => {
    const result = await admitOrStage({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: incompleteOutput("AOS-2"),
      sourceKind: "shopify",
      actor: TEST_ACTOR,
      channelCode: CHANNEL_CODE
      // No channelCodeToId needed: incomplete has no pricing observations
    });

    expect(result.outcome).toBe("staged");
    expect(result.productId).toBeNull();
    expect(result.stagedProductId).not.toBeNull();
    expect(typeof result.stagedProductId).toBe("string");

    // Verify it landed in staged_products
    const rows = await db
      .select()
      .from(schema.stagedProducts)
      .where(eq(schema.stagedProducts.tenantId, TENANT_ID));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.stagedProductId === result.stagedProductId)).toBe(true);
  });

  // ---- Case 3: incomplete re-ingest matching a live product → enriched ------
  test("3. incomplete re-ingest of live product by GTIN → outcome=enriched, productId set", async () => {
    const gtin = "c3000000000003";

    // First: admit a complete product (creates the live catalog row)
    const first = await admitOrStage({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: completeOutput(gtin, "AOS-3-first"),
      sourceKind: "shopify",
      actor: TEST_ACTOR,
      channelCode: CHANNEL_CODE,
      channelCodeToId: { [CHANNEL_CODE]: CHANNEL }
    });
    expect(first.outcome).toBe("admitted");
    expect(first.productId).not.toBeNull();
    const liveProductId = first.productId;

    // Second: re-ingest same GTIN but incomplete (missing category_path + pricing)
    // resolveIdentity will find the live product by GTIN → enriched path
    const second = await admitOrStage({
      db,
      tenantId: TENANT,
      merchantId: MERCHANT,
      adapterOutput: incompleteWithGtin(gtin, "AOS-3-second"),
      sourceKind: "shopify",
      actor: TEST_ACTOR,
      channelCode: CHANNEL_CODE
      // No channelCodeToId needed: enrichment output has no pricing observations
    });

    expect(second.outcome).toBe("enriched");
    expect(second.productId).toBe(liveProductId);
    expect(second.stagedProductId).toBeNull();
  });
});
