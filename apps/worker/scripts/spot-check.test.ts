// Tests for the spot-check report tool (Task 7.4).
//
// Runs against the real dev DB. Seeds legacy product_versions + linked FK
// chain, runs the backfill (runBackfill) to write catalog rows, then
// exercises runSpotCheck to verify the HTML report is correct.
//
// Three scenarios:
//   1. Happy path       — seed 3 products, run spot-check, HTML written with
//                         all 3 product_ids and correct summary counts.
//   2. Deterministic    — same --seed value produces identical HTML output
//                         (modulo timestamp, which is injected via _timestampOverride).
//   3. Empty tenant     — no backfilled products → HTML written with 0 sampled,
//                         no errors.
//
// Uses the same seed helpers as backfill-catalog.test.ts / validate-backfill.test.ts.
// UUIDs are prefixed with "e0…" to avoid collision with those test suites.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { runSpotCheck, escapeHtml } from "./spot-check.js";

// ---- Constants -------------------------------------------------------------

const TENANT = TEST_TENANT_ID;
const MERCHANT = TEST_MERCHANT_ID;
const TEST_ACTOR = "test:spot-check";

// Fixed UUIDs — "e0…" prefix to avoid collisions with other test suites.
const POLICY_VERSION_ID = "e0000000-0000-0000-0000-000000000001";

const PRODUCT_ID_1 = "e0000000-0000-0000-0000-000000000010";
const PRODUCT_ID_2 = "e0000000-0000-0000-0000-000000000020";
const PRODUCT_ID_3 = "e0000000-0000-0000-0000-000000000030";

const ARTIFACT_ID_1 = "e0000000-0000-0000-0000-000000000100";
const ARTIFACT_ID_2 = "e0000000-0000-0000-0000-000000000200";
const ARTIFACT_ID_3 = "e0000000-0000-0000-0000-000000000300";

const FACT_SET_ID_1 = "e0000000-0000-0000-0000-000000001000";
const FACT_SET_ID_2 = "e0000000-0000-0000-0000-000000002000";
const FACT_SET_ID_3 = "e0000000-0000-0000-0000-000000003000";

const DIFF_ID_1 = "e0000000-0000-0000-0000-000000010000";
const DIFF_ID_2 = "e0000000-0000-0000-0000-000000020000";
const DIFF_ID_3 = "e0000000-0000-0000-0000-000000030000";

const EXTRACTION_RUN_ID_1 = "e0000000-0000-0000-0000-000000100000";
const EXTRACTION_RUN_ID_2 = "e0000000-0000-0000-0000-000000200000";
const EXTRACTION_RUN_ID_3 = "e0000000-0000-0000-0000-000000300000";

// Lexicographic order e1 < e2 < e3 — matters for cursor-based backfill batching.
const PV_ID_1 = "e1000000-0000-0000-0000-000000000001";
const PV_ID_2 = "e2000000-0000-0000-0000-000000000002";
const PV_ID_3 = "e3000000-0000-0000-0000-000000000003";

const FIXED_TIMESTAMP = "2026-05-22T00:00:00.000Z";
const FIXED_SEED = 42;

// ---- Seed helpers ----------------------------------------------------------

async function ensurePolicyVersion(db: DrizzleClient): Promise<void> {
  await db
    .insert(schema.policyVersions)
    .values({
      id: POLICY_VERSION_ID,
      version: "v1-spot-check-test",
      active: false,
      scoringWeights: {
        identity: 0.4,
        category: 0.15,
        fieldMapping: 0.15,
        variant: 0.1,
        schema: 0.1,
        media: 0.05,
        sourceReliability: 0.05
      }
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
 * Seed one complete legacy product_version with its FK chain.
 * Mirrors the helper in backfill-catalog.test.ts / validate-backfill.test.ts.
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

async function cleanupBackfillCursor(db: DrizzleClient): Promise<void> {
  await db
    .delete(schema.backfillCursor)
    .where(eq(schema.backfillCursor.tenantId, TENANT));
}

async function cleanupSourcePriority(db: DrizzleClient): Promise<void> {
  await db
    .delete(schema.sourcePriority)
    .where(eq(schema.sourcePriority.actor, TEST_ACTOR));
}

async function cleanup(db: DrizzleClient): Promise<void> {
  await cleanupCatalogRows(db);
  await cleanupBackfillCursor(db);
  await cleanupLegacyRows(db);
  await cleanupSourcePriority(db);
}

// ---- Unit tests (no DB) ----------------------------------------------------

describe("spot-check (Task 7.4)", () => {
  describe("unit: escapeHtml", () => {
    test("escapes all five special HTML characters", () => {
      expect(escapeHtml("& < > \" '")).toBe("&amp; &lt; &gt; &quot; &#39;");
    });

    test("leaves safe strings untouched", () => {
      expect(escapeHtml("hello world")).toBe("hello world");
    });

    test("handles empty string", () => {
      expect(escapeHtml("")).toBe("");
    });
  });

  // ---- Integration tests (require DB) ---------------------------------------

  describe("integration", () => {
    let db: DrizzleClient;
    let tmpDir: string;

    beforeAll(async () => {
      db = await connectTestDb();
      await ensureTestTenant(db);
      await ensureTestMerchant(db);
      await ensureTestChannel(db);
      await cleanup(db);
      await ensurePolicyVersion(db);
      await seedSourcePriority(db);

      // Seed 3 product_versions for tests 1 & 2
      await seedProductVersion(db, {
        productId: PRODUCT_ID_1,
        pvId: PV_ID_1,
        diffId: DIFF_ID_1,
        factSetId: FACT_SET_ID_1,
        extractionRunId: EXTRACTION_RUN_ID_1,
        artifactId: ARTIFACT_ID_1,
        title: "Spot-Check Widget Alpha",
        brand: "AlphaBrand",
        gtin: "08000000000001",
        basePrice: "19.99"
      });
      await seedProductVersion(db, {
        productId: PRODUCT_ID_2,
        pvId: PV_ID_2,
        diffId: DIFF_ID_2,
        factSetId: FACT_SET_ID_2,
        extractionRunId: EXTRACTION_RUN_ID_2,
        artifactId: ARTIFACT_ID_2,
        title: "Spot-Check Widget Beta",
        brand: "BetaBrand",
        gtin: "08000000000002"
      });
      await seedProductVersion(db, {
        productId: PRODUCT_ID_3,
        pvId: PV_ID_3,
        diffId: DIFF_ID_3,
        factSetId: FACT_SET_ID_3,
        extractionRunId: EXTRACTION_RUN_ID_3,
        artifactId: ARTIFACT_ID_3,
        title: "Spot-Check Widget Gamma"
        // no brand / gtin / price — minimal seed
      });

      // Run the backfill to write catalog_products rows
      await runBackfill({ db }, { tenantId: TENANT, batchSize: 10 });

      // Scratch directory for HTML output files
      tmpDir = await mkdtemp(join(tmpdir(), "spot-check-test-"));
    });

    afterAll(async () => {
      await cleanup(db);
      await closeTestDb();
      await rm(tmpDir, { recursive: true, force: true });
    });

    // ---- Test 1: Happy path -------------------------------------------------

    test("1. happy path — HTML written, contains all 3 product_ids, summary counts correct", async () => {
      const outputPath = join(tmpDir, "test1-report.html");

      const report = await runSpotCheck(
        { db },
        {
          tenantId: TENANT,
          sampleSize: 100,
          outputPath,
          seed: FIXED_SEED,
          _timestampOverride: FIXED_TIMESTAMP
        }
      );

      // Report structure
      expect(report.tenantId).toBe(TENANT);
      expect(report.totalSampled).toBeGreaterThanOrEqual(3);
      expect(report.sampleSize).toBe(100);
      expect(report.seed).toBe(FIXED_SEED);
      expect(report.generatedAt).toBe(FIXED_TIMESTAMP);
      expect(report.allMatch + report.withDiffs + report.withLosses).toBe(
        report.totalSampled
      );

      // HTML file was written
      const html = await readFile(outputPath, "utf-8");
      expect(html).toBeTruthy();
      expect(html.length).toBeGreaterThan(100);

      // HTML contains the titles from all 3 seeded products
      expect(html).toContain("Spot-Check Widget Alpha");
      expect(html).toContain("Spot-Check Widget Beta");
      expect(html).toContain("Spot-Check Widget Gamma");

      // The report also embeds the catalog product_ids in the card anchors.
      // Verify that 3 product cards were rendered (each has id="product-<uuid>").
      const productCardMatches = html.match(/id="product-[0-9a-f-]+"/g);
      expect(productCardMatches).toBeDefined();
      expect(productCardMatches!.length).toBeGreaterThanOrEqual(3);

      // HTML has the summary block
      expect(html).toContain("Catalog Spot-Check Report");
      expect(html).toContain(TENANT);

      // No raw unescaped injection points (basic sanity)
      expect(html).not.toContain("<script");
    });

    // ---- Test 2: Deterministic seed -----------------------------------------

    test("2. deterministic seed — same seed produces identical HTML (modulo injected timestamp)", async () => {
      const outputA = join(tmpDir, "test2a-report.html");
      const outputB = join(tmpDir, "test2b-report.html");

      await runSpotCheck(
        { db },
        {
          tenantId: TENANT,
          sampleSize: 100,
          outputPath: outputA,
          seed: FIXED_SEED,
          _timestampOverride: FIXED_TIMESTAMP
        }
      );
      await runSpotCheck(
        { db },
        {
          tenantId: TENANT,
          sampleSize: 100,
          outputPath: outputB,
          seed: FIXED_SEED,
          _timestampOverride: FIXED_TIMESTAMP
        }
      );

      const htmlA = await readFile(outputA, "utf-8");
      const htmlB = await readFile(outputB, "utf-8");

      // Same seed + same timestamp override → byte-identical
      expect(htmlA).toBe(htmlB);
    });

    // ---- Test 3: Empty tenant -----------------------------------------------

    test("3. empty tenant — no backfilled products → HTML written with 0 sampled, no error", async () => {
      const outputPath = join(tmpDir, "test3-report.html");
      // Use a different UUID that has no data
      const emptyTenantId = "ffffffff-ffff-ffff-ffff-ffffffffffff";

      const report = await runSpotCheck(
        { db },
        {
          tenantId: emptyTenantId,
          sampleSize: 10,
          outputPath,
          seed: FIXED_SEED,
          _timestampOverride: FIXED_TIMESTAMP
        }
      );

      expect(report.totalSampled).toBe(0);
      expect(report.allMatch).toBe(0);
      expect(report.withDiffs).toBe(0);
      expect(report.withLosses).toBe(0);

      // HTML was still written
      const html = await readFile(outputPath, "utf-8");
      expect(html).toBeTruthy();
      expect(html).toContain("Catalog Spot-Check Report");
      // Summary shows 0 sampled — the template renders "(sampled: 0)"
      expect(html).toContain("sampled: 0");
    });
  });
});
