// Tests for the catalog backfill validation harness (Task 7.2).
//
// Runs against the real dev DB. Builds on the same seed helpers used by the
// backfill test (Task 7.1). Each test scenario seeds a product_version, runs
// the backfill (runBackfill) to write catalog rows, then exercises the
// validator (runValidation) to check for required-field loss.
//
// Three scenarios tested:
//   1. Happy path   — full data → validation passes, totalPassed=1, totalFailed=0.
//   2. Detect loss  — winning_values tampered (title removed) → totalFailed=1,
//                     failuresByField={title:1}.
//   3. Allowed delta — extra _field_source metadata in winning_values → still passes
//                      because allowed-delta keys are not counted as failures.
//
// All three run on a single dataset to avoid repeated schema seeding overhead.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import {
  closeTestDb,
  connectTestDb,
  ensureTestChannel,
  ensureTestMerchant,
  ensureTestTenant,
  TEST_MERCHANT_ID,
  TEST_TENANT_ID
} from "@aonex/db/testing";
import { runBackfill } from "./backfill-catalog.js";
import {
  runValidation,
  comparePrimary,
  comparePricing,
  extractWinningValue,
  normalizeForCompare
} from "./validate-backfill.js";

// ---- Constants -------------------------------------------------------------

const TENANT = TEST_TENANT_ID;
const MERCHANT = TEST_MERCHANT_ID;
const TEST_ACTOR = "test:validate-backfill";

// Fixed UUIDs — different prefix from backfill tests (b0…) to avoid collision
const POLICY_VERSION_ID = "c0000000-0000-0000-0000-000000000001";
const PRODUCT_ID_1      = "c0000000-0000-0000-0000-000000000010";
const ARTIFACT_ID_1     = "c0000000-0000-0000-0000-000000000100";
const FACT_SET_ID_1     = "c0000000-0000-0000-0000-000000001000";
const DIFF_ID_1         = "c0000000-0000-0000-0000-000000010000";
const EXTRACTION_RUN_ID_1 = "c0000000-0000-0000-0000-000000100000";
const PV_ID_1           = "c1000000-0000-0000-0000-000000000001";

// ---- Seed helpers ----------------------------------------------------------

async function ensurePolicyVersion(db: DrizzleClient): Promise<void> {
  await db
    .insert(schema.policyVersions)
    .values({
      id: POLICY_VERSION_ID,
      version: "v1-validate-backfill-test",
      active: false,
      scoringWeights: { identity: 0.4, category: 0.15, fieldMapping: 0.15, variant: 0.1, schema: 0.1, media: 0.05, sourceReliability: 0.05 }
    })
    .onConflictDoNothing();
}

async function seedSourcePriority(db: DrizzleClient): Promise<void> {
  await db
    .insert(schema.sourcePriority)
    .values({
      tenantId: null,
      attributeCode: null,
      sourceGlob: "*",
      channelScope: null,
      priority: 100,
      rulesVersion: 1,
      actor: TEST_ACTOR
    })
    .onConflictDoNothing();
}

/**
 * Seed one complete legacy product_version with extracted_facts.
 * Includes title + brand fact rows to give convertFromFacts something to work with.
 */
async function seedProductVersion(
  db: DrizzleClient,
  opts: {
    productId: string;
    pvId: string;
    diffId: string;
    factSetId: string;
    extractionRunId: string;
    artifactId: string;
    title: string;
    brand?: string;
    gtin?: string;
    basePrice?: string;
  }
): Promise<void> {
  const {
    productId,
    pvId,
    diffId,
    factSetId,
    extractionRunId,
    artifactId,
    title,
    brand,
    gtin,
    basePrice
  } = opts;

  // source_artifacts
  await db
    .insert(schema.sourceArtifacts)
    .values({
      id: artifactId,
      tenantId: TENANT,
      merchantId: MERCHANT,
      sourceType: "marketplace_connector",
      sourceMarketplace: "shopify",
      sourceExternalId: `shopify-${artifactId}`,
      rawData: { title, source: "test" },
      checksum: `checksum-${artifactId}`,
      status: "completed"
    })
    .onConflictDoNothing();

  // extraction_runs
  await db
    .insert(schema.extractionRuns)
    .values({
      id: extractionRunId,
      artifactId,
      tenantId: TENANT,
      merchantId: MERCHANT,
      extractorVersion: "test-v1",
      mapperVersion: "test-v1",
      policyVersionId: POLICY_VERSION_ID,
      status: "succeeded"
    })
    .onConflictDoNothing();

  // extracted_fact_sets
  await db
    .insert(schema.extractedFactSets)
    .values({
      id: factSetId,
      extractionRunId,
      artifactId,
      tenantId: TENANT,
      merchantId: MERCHANT
    })
    .onConflictDoNothing();

  // extracted_facts — title
  await db
    .insert(schema.extractedFacts)
    .values({
      factSetId,
      tenantId: TENANT,
      rawKey: "title",
      canonicalPath: "title",
      extractedValue: title,
      normalizedValue: title,
      sourcePointer: "$.title",
      extractionMethod: "direct",
      confidence: "0.9000"
    })
    .onConflictDoNothing();

  // extracted_facts — brand (optional)
  if (brand) {
    await db
      .insert(schema.extractedFacts)
      .values({
        factSetId,
        tenantId: TENANT,
        rawKey: "brand",
        canonicalPath: "brand",
        extractedValue: brand,
        normalizedValue: brand,
        sourcePointer: "$.brand",
        extractionMethod: "direct",
        confidence: "0.8000"
      })
      .onConflictDoNothing();
  }

  // extracted_facts — gtin (optional)
  if (gtin) {
    await db
      .insert(schema.extractedFacts)
      .values({
        factSetId,
        tenantId: TENANT,
        rawKey: "gtin",
        canonicalPath: "gtin",
        extractedValue: gtin,
        normalizedValue: gtin,
        sourcePointer: "$.gtin",
        extractionMethod: "direct",
        confidence: "0.9500"
      })
      .onConflictDoNothing();
  }

  // proposed_diffs
  await db
    .insert(schema.proposedDiffs)
    .values({
      id: diffId,
      tenantId: TENANT,
      merchantId: MERCHANT,
      sourceFactSetId: factSetId,
      productId,
      diffType: "create",
      status: "approved",
      policyVersionId: POLICY_VERSION_ID,
      confidenceScore: "0.7500",
      actorType: "system",
      diffPayload: { title }
    })
    .onConflictDoNothing();

  // products (aggregate root)
  await db
    .insert(schema.products)
    .values({
      id: productId,
      tenantId: TENANT,
      merchantId: MERCHANT,
      status: "draft",
      currentVersionId: null
    })
    .onConflictDoNothing();

  // product_versions
  await db
    .insert(schema.productVersions)
    .values({
      id: pvId,
      productId,
      tenantId: TENANT,
      merchantId: MERCHANT,
      proposedDiffId: diffId,
      title,
      ...(brand ? { brand } : {}),
      ...(gtin ? { gtin } : {}),
      ...(basePrice ? { basePrice, currency: "AUD" } : {}),
      confidenceScore: "0.7500",
      schemaVersion: "1",
      attributesJson: {}
    })
    .onConflictDoNothing();

  // Update products.current_version_id
  await db
    .update(schema.products)
    .set({ currentVersionId: pvId })
    .where(and(eq(schema.products.id, productId), eq(schema.products.tenantId, TENANT)));
}

// ---- Cleanup ---------------------------------------------------------------

async function cleanupCatalogRows(db: DrizzleClient): Promise<void> {
  await db
    .delete(schema.catalogPricingObservations)
    .where(eq(schema.catalogPricingObservations.tenantId, TENANT));
  await db
    .delete(schema.catalogInventoryObservations)
    .where(eq(schema.catalogInventoryObservations.tenantId, TENANT));
  await db.execute(
    sql`DELETE FROM catalog_events WHERE tenant_id = ${TENANT}`
  );
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions DISABLE TRIGGER trg_revisions_immutable`
  );
  await db
    .delete(schema.catalogProductRevisions)
    .where(eq(schema.catalogProductRevisions.tenantId, TENANT));
  await db.execute(
    sql`ALTER TABLE catalog_product_revisions ENABLE TRIGGER trg_revisions_immutable`
  );
  await db
    .delete(schema.identityLog)
    .where(eq(schema.identityLog.tenantId, TENANT));
  await db
    .delete(schema.reviewTasks)
    .where(eq(schema.reviewTasks.tenantId, TENANT));
  await db
    .delete(schema.catalogProducts)
    .where(eq(schema.catalogProducts.tenantId, TENANT));
}

async function cleanupLegacyRows(db: DrizzleClient): Promise<void> {
  await db
    .delete(schema.productIdentities)
    .where(eq(schema.productIdentities.tenantId, TENANT));
  await db
    .delete(schema.productVersions)
    .where(eq(schema.productVersions.tenantId, TENANT));
  await db
    .update(schema.products)
    .set({ currentVersionId: null })
    .where(eq(schema.products.tenantId, TENANT));
  await db
    .delete(schema.products)
    .where(eq(schema.products.tenantId, TENANT));
  await db
    .delete(schema.proposedDiffs)
    .where(eq(schema.proposedDiffs.tenantId, TENANT));
  await db
    .delete(schema.extractedFacts)
    .where(eq(schema.extractedFacts.tenantId, TENANT));
  await db
    .delete(schema.extractedFactSets)
    .where(eq(schema.extractedFactSets.tenantId, TENANT));
  await db
    .delete(schema.extractionRuns)
    .where(eq(schema.extractionRuns.tenantId, TENANT));
  await db
    .delete(schema.sourceArtifacts)
    .where(eq(schema.sourceArtifacts.tenantId, TENANT));
}

async function cleanupSourcePriority(db: DrizzleClient): Promise<void> {
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
}

async function cleanupBackfillCursor(db: DrizzleClient): Promise<void> {
  await db
    .delete(schema.backfillCursor)
    .where(eq(schema.backfillCursor.tenantId, TENANT));
}

async function cleanup(db: DrizzleClient): Promise<void> {
  await cleanupCatalogRows(db);
  await cleanupBackfillCursor(db);
  await cleanupLegacyRows(db);
  await cleanupSourcePriority(db);
}

// ---- Tests -----------------------------------------------------------------

describe("validate-backfill (Task 7.2)", () => {
  let db: DrizzleClient;

  // ---- Unit tests for helpers (no DB needed) --------------------------------

  describe("unit: normalizeForCompare", () => {
    test("trims and lowercases strings", () => {
      expect(normalizeForCompare("  Hello World  ")).toBe("hello world");
    });

    test("returns null for null/undefined", () => {
      expect(normalizeForCompare(null)).toBeNull();
      expect(normalizeForCompare(undefined)).toBeNull();
    });

    test("returns numbers as-is", () => {
      expect(normalizeForCompare(42)).toBe(42);
    });
  });

  describe("unit: comparePrimary", () => {
    test("equal normalized values → equal", () => {
      expect(comparePrimary("title", "Widget Pro", "widget pro").equal).toBe(true);
    });

    test("legacy null and new null → equal (no data to lose)", () => {
      expect(comparePrimary("brand", null, null).equal).toBe(true);
    });

    test("legacy has value but new is null → not equal (loss)", () => {
      const r = comparePrimary("title", "Widget Pro", null);
      expect(r.equal).toBe(false);
      expect(r.reason).toContain("title");
    });

    test("legacy null but new has value → equal (allowed delta)", () => {
      expect(comparePrimary("brand", null, "SomeBrand").equal).toBe(true);
    });

    test("both present but different → not equal", () => {
      const r = comparePrimary("gtin", "12345678901234", "00000000000000");
      expect(r.equal).toBe(false);
    });
  });

  describe("unit: comparePricing", () => {
    const mockPricing = {
      list_price: 49.99,
      sale_price: null,
      currency: "AUD",
      discount_percent: null,
      price_per_unit: null
    };

    test("matching currency and amount → equal", () => {
      const r = comparePricing(mockPricing, [
        { currency: "AUD", primaryAmount: "49.99", tiers: [] }
      ]);
      expect(r.equal).toBe(true);
    });

    test("no legacy pricing → always equal (nothing to lose)", () => {
      const noPricing = { ...mockPricing, list_price: null, sale_price: null };
      expect(comparePricing(noPricing, []).equal).toBe(true);
    });

    test("legacy pricing but no new rows → loss", () => {
      const r = comparePricing(mockPricing, []);
      expect(r.equal).toBe(false);
      expect(r.reason).toContain("primary_pricing");
    });

    test("currency mismatch → loss", () => {
      const r = comparePricing(mockPricing, [
        { currency: "USD", primaryAmount: "49.99", tiers: [] }
      ]);
      expect(r.equal).toBe(false);
      expect(r.reason).toContain("currency");
    });

    test("amount mismatch → loss", () => {
      const r = comparePricing(mockPricing, [
        { currency: "AUD", primaryAmount: "39.99", tiers: [] }
      ]);
      expect(r.equal).toBe(false);
      expect(r.reason).toContain("amount mismatch");
    });

    test("sale_price takes precedence over list_price", () => {
      const withSale = { ...mockPricing, list_price: 99.99, sale_price: 49.99 };
      // Should compare against sale_price (49.99), not list_price
      const ok = comparePricing(withSale, [
        { currency: "AUD", primaryAmount: "49.99", tiers: [] }
      ]);
      expect(ok.equal).toBe(true);

      const fail = comparePricing(withSale, [
        { currency: "AUD", primaryAmount: "99.99", tiers: [] }
      ]);
      expect(fail.equal).toBe(false);
    });
  });

  describe("unit: extractWinningValue", () => {
    test("extracts _unscoped channel/_unscoped locale value", () => {
      const wv = {
        title: {
          _unscoped: { _unscoped: "Widget Pro" }
        }
      };
      expect(extractWinningValue(wv, "title")).toBe("Widget Pro");
    });

    test("returns null for missing attribute", () => {
      expect(extractWinningValue({}, "title")).toBeNull();
    });

    test("prefers _unscoped over other channels", () => {
      const wv = {
        brand: {
          "shopify-au": { _unscoped: "ChannelBrand" },
          _unscoped: { _unscoped: "UnscopedBrand" }
        }
      };
      expect(extractWinningValue(wv, "brand")).toBe("UnscopedBrand");
    });
  });

  // ---- Integration tests (require DB) ---------------------------------------

  describe("integration", () => {
    beforeAll(async () => {
      db = await connectTestDb();
      await ensureTestTenant(db);
      await ensureTestMerchant(db);
      await ensureTestChannel(db);
      await cleanup(db);
      await ensurePolicyVersion(db);
      await seedSourcePriority(db);

      // Seed one product_version for all integration tests
      await seedProductVersion(db, {
        productId: PRODUCT_ID_1,
        pvId: PV_ID_1,
        diffId: DIFF_ID_1,
        factSetId: FACT_SET_ID_1,
        extractionRunId: EXTRACTION_RUN_ID_1,
        artifactId: ARTIFACT_ID_1,
        title: "Validation Test Widget",
        brand: "TestBrand",
        gtin: "07000000000002",
        basePrice: "99.95"
      });

      // Run backfill to create catalog_products rows
      await runBackfill({ db }, { tenantId: TENANT, batchSize: 10 });
    });

    afterAll(async () => {
      await cleanup(db);
      await closeTestDb();
    });

    // ---- Test 1: Happy path ------------------------------------------------

    test("1. happy path — zero field loss → totalPassed=1, totalFailed=0", async () => {
      const report = await runValidation(
        { db },
        { tenantId: TENANT }
      );

      expect(report.tenantId).toBe(TENANT);
      expect(report.totalScanned).toBeGreaterThanOrEqual(1);
      // All backfilled products should pass
      expect(report.totalFailed).toBe(0);
      expect(report.totalErrors).toBe(0);
      expect(report.totalPassed).toBe(report.totalScanned);
      // Invariant: totalScanned === totalPassed + totalFailed + totalErrors
      expect(report.totalPassed + report.totalFailed + report.totalErrors).toBe(report.totalScanned);
      expect(Object.keys(report.failuresByField)).toHaveLength(0);
      expect(report.sampleFailures).toHaveLength(0);
      expect(report.generatedAt).toBeTruthy();
    });

    // ---- Test 2: Detect loss (title tampered) --------------------------------

    test("2. detect loss — title removed from winning_values → totalFailed≥1, failuresByField.title≥1", async () => {
      // Find the backfilled catalog_products row
      const rows = await db
        .select()
        .from(schema.catalogProducts)
        .where(eq(schema.catalogProducts.tenantId, TENANT))
        .limit(1);
      const product = rows[0];
      expect(product).toBeDefined();

      // Tamper: remove 'title' from winning_values
      const originalWv = (product!.winningValues ?? {}) as Record<string, unknown>;
      const tamperedWv = { ...originalWv };
      delete tamperedWv["title"];

      await db
        .update(schema.catalogProducts)
        .set({ winningValues: tamperedWv })
        .where(eq(schema.catalogProducts.productId, product!.productId));

      try {
        const report = await runValidation(
          { db },
          { tenantId: TENANT }
        );

        // At least one product should fail due to title loss
        expect(report.totalFailed).toBeGreaterThanOrEqual(1);
        expect(report.failuresByField["title"]).toBeGreaterThanOrEqual(1);
        expect(report.sampleFailures.length).toBeGreaterThanOrEqual(1);
        const titleFailure = report.sampleFailures.find(
          (r) => r.failures.some((f) => f.field === "title")
        );
        expect(titleFailure).toBeDefined();
        expect(titleFailure!.pass).toBe(false);
      } finally {
        // Restore winning_values so other tests aren't affected
        await db
          .update(schema.catalogProducts)
          .set({ winningValues: originalWv })
          .where(eq(schema.catalogProducts.productId, product!.productId));
      }
    });

    // ---- Test 3: Allowed deltas (extra _field_source key) --------------------

    test("3. allowed deltas — extra _field_source in winning_values → still passes", async () => {
      // Find the backfilled catalog_products row
      const rows = await db
        .select()
        .from(schema.catalogProducts)
        .where(eq(schema.catalogProducts.tenantId, TENANT))
        .limit(1);
      const product = rows[0];
      expect(product).toBeDefined();

      // Inject extra _field_source metadata into winning_values (new schema allowed delta)
      const originalWv = (product!.winningValues ?? {}) as Record<string, unknown>;
      const enrichedWv = {
        ...originalWv,
        _field_source: { title: "structured", brand: "llm-text" },
        _extraction_meta: { passes_run: ["v1"], tokens_used: 500, cost_usd: 0.001, latency_ms: 300 }
      };

      await db
        .update(schema.catalogProducts)
        .set({ winningValues: enrichedWv })
        .where(eq(schema.catalogProducts.productId, product!.productId));

      try {
        const report = await runValidation(
          { db },
          { tenantId: TENANT }
        );

        // Extra allowed-delta keys should not cause failures
        expect(report.totalFailed).toBe(0);
        expect(report.totalErrors).toBe(0);
        expect(report.totalPassed).toBe(report.totalScanned);
        // Invariant: totalScanned === totalPassed + totalFailed + totalErrors
        expect(report.totalPassed + report.totalFailed + report.totalErrors).toBe(report.totalScanned);
        expect(Object.keys(report.failuresByField)).toHaveLength(0);
      } finally {
        // Restore winning_values
        await db
          .update(schema.catalogProducts)
          .set({ winningValues: originalWv })
          .where(eq(schema.catalogProducts.productId, product!.productId));
      }
    });
  });
});
