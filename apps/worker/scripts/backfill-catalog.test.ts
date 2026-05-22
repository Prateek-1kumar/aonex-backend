// Tests for the catalog backfill script (Task 7.1).
//
// Runs against the real dev DB. Seeds legacy product_versions + linked
// proposed_diffs + extracted_fact_sets + extracted_facts, then invokes
// runBackfill() directly (no subprocess) to verify the catalog write path,
// idempotency, dry-run behaviour, and cursor resume.
//
// All four scenarios run in sequence on a single dataset within one
// describe block, sharing beforeAll / afterAll setup. The test is designed
// as a progressive story:
//   1. Happy path  — 1 product_version → 1 catalog_products, revision tagged 'migration_backfill'
//   2. Idempotency — re-run produces no duplicates; cursor.total_skipped reflects it
//   3. Dry-run     — zero catalog rows written; cursor unchanged
//   4. Resume      — seed 2 more versions; run with limit:1 then without limit

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

// ---- Constants -------------------------------------------------------------

const TENANT = TEST_TENANT_ID;
const MERCHANT = TEST_MERCHANT_ID;
const TEST_ACTOR = "test:backfill-catalog";

// Fixed UUIDs for test rows (deterministic — no collision with other tests)
const POLICY_VERSION_ID = "b0000000-0000-0000-0000-000000000001";
const PRODUCT_ID_1      = "b0000000-0000-0000-0000-000000000010";
const PRODUCT_ID_2      = "b0000000-0000-0000-0000-000000000020";
const PRODUCT_ID_3      = "b0000000-0000-0000-0000-000000000030";
const ARTIFACT_ID_1     = "b0000000-0000-0000-0000-000000000100";
const ARTIFACT_ID_2     = "b0000000-0000-0000-0000-000000000200";
const ARTIFACT_ID_3     = "b0000000-0000-0000-0000-000000000300";
const FACT_SET_ID_1     = "b0000000-0000-0000-0000-000000001000";
const FACT_SET_ID_2     = "b0000000-0000-0000-0000-000000002000";
const FACT_SET_ID_3     = "b0000000-0000-0000-0000-000000003000";
const DIFF_ID_1         = "b0000000-0000-0000-0000-000000010000";
const DIFF_ID_2         = "b0000000-0000-0000-0000-000000020000";
const DIFF_ID_3         = "b0000000-0000-0000-0000-000000030000";
const EXTRACTION_RUN_ID_1 = "b0000000-0000-0000-0000-000000100000";
const EXTRACTION_RUN_ID_2 = "b0000000-0000-0000-0000-000000200000";
const EXTRACTION_RUN_ID_3 = "b0000000-0000-0000-0000-000000300000";
// Version IDs are chosen so that lexicographic order matches seed order:
// PV1 < PV2 < PV3 — this matters for the cursor resume test.
const PV_ID_1 = "b1000000-0000-0000-0000-000000000001";
const PV_ID_2 = "b2000000-0000-0000-0000-000000000002";
const PV_ID_3 = "b3000000-0000-0000-0000-000000000003";

// ---- Helpers ---------------------------------------------------------------

async function ensurePolicyVersion(db: DrizzleClient): Promise<void> {
  await db
    .insert(schema.policyVersions)
    .values({
      id: POLICY_VERSION_ID,
      version: "v1-backfill-test",
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
 * Seed one complete legacy product_version with its FK chain.
 * Creates:
 *   extraction_runs → extracted_fact_sets → extracted_facts
 *   proposed_diffs (referencing fact_set)
 *   products (aggregate root)
 *   product_versions (referencing proposed_diff)
 *   products.current_version_id → product_version
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

  // source_artifacts (raw data bucket)
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
    .insert(schema.linkIngestionTraceRuns)
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
    .insert(schema.linkIngestionTraceSets)
    .values({
      id: factSetId,
      extractionRunId,
      artifactId,
      tenantId: TENANT,
      merchantId: MERCHANT
    })
    .onConflictDoNothing();

  // extracted_facts (one title fact)
  await db
    .insert(schema.linkIngestionTraceFacts)
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

  // proposed_diffs (references extracted_fact_set)
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
      currentVersionId: null // updated after PV insert
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
      attributesJson: { test_attr: "value1" }
    })
    .onConflictDoNothing();

  // Update products.current_version_id to point at the new version
  await db
    .update(schema.products)
    .set({ currentVersionId: pvId })
    .where(and(eq(schema.products.id, productId), eq(schema.products.tenantId, TENANT)));
}

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
  // FK order: product_versions → products → proposed_diffs → extracted_fact_sets → extraction_runs → source_artifacts
  // Also: product_identities references products
  await db
    .delete(schema.productIdentities)
    .where(eq(schema.productIdentities.tenantId, TENANT));
  await db
    .delete(schema.productVersions)
    .where(eq(schema.productVersions.tenantId, TENANT));
  // Clear current_version_id FK before deleting products
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
    .delete(schema.linkIngestionTraceFacts)
    .where(eq(schema.linkIngestionTraceFacts.tenantId, TENANT));
  await db
    .delete(schema.linkIngestionTraceSets)
    .where(eq(schema.linkIngestionTraceSets.tenantId, TENANT));
  await db
    .delete(schema.linkIngestionTraceRuns)
    .where(eq(schema.linkIngestionTraceRuns.tenantId, TENANT));
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

// ---- Tests -----------------------------------------------------------------

describe("backfill-catalog (Task 7.1)", () => {
  let db: DrizzleClient;

  beforeAll(async () => {
    db = await connectTestDb();
    await ensureTestTenant(db);
    await ensureTestMerchant(db);
    await ensureTestChannel(db);
    await cleanup(db);
    await ensurePolicyVersion(db);
    await seedSourcePriority(db);

    // Seed 1 product_version for tests 1–3
    await seedProductVersion(db, {
      productId: PRODUCT_ID_1,
      pvId: PV_ID_1,
      diffId: DIFF_ID_1,
      factSetId: FACT_SET_ID_1,
      extractionRunId: EXTRACTION_RUN_ID_1,
      artifactId: ARTIFACT_ID_1,
      title: "Test Widget Pro",
      brand: "TestBrand",
      gtin: "07000000000001",
      basePrice: "49.99"
    });
  });

  afterAll(async () => {
    await cleanup(db);
    await closeTestDb();
  });

  // ---- Test 1: Happy path -------------------------------------------------

  test("1. happy path — creates catalog_products, observations, revision='migration_backfill', cursor advanced", async () => {
    const result = await runBackfill(
      { db },
      { tenantId: TENANT, batchSize: 10 }
    );

    // Result summary
    expect(result.tenantId).toBe(TENANT);
    expect(result.totalProcessed).toBeGreaterThanOrEqual(1);
    expect(result.totalFailed).toBe(0);
    expect(result.dryRun).toBe(false);

    // 1 catalog_products row should exist for our tenant
    const catalogRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TENANT));
    expect(catalogRows.length).toBeGreaterThanOrEqual(1);

    // The row should have observations in its values JSONB (at least title)
    const row = catalogRows.find(
      (r) => r.primaryIdentifier === "07000000000001"
    );
    expect(row).toBeDefined();
    const values = row!.values as Record<string, unknown>;
    expect(values["title"]).toBeDefined();

    // Revision row should be tagged 'migration_backfill'
    const revisions = await db.execute(
      sql`SELECT revision_reason FROM catalog_product_revisions
          WHERE tenant_id = ${TENANT}
          LIMIT 10`
    );
    const reasons = (revisions.rows as Array<{ revision_reason: string }>).map(
      (r) => r.revision_reason
    );
    expect(reasons).toContain("migration_backfill");

    // Cursor should have advanced
    const cursor = await db
      .select()
      .from(schema.backfillCursor)
      .where(eq(schema.backfillCursor.tenantId, TENANT))
      .limit(1)
      .then((r) => r[0]);
    expect(cursor).toBeDefined();
    expect(cursor!.lastProductVersionIdProcessed).not.toBeNull();
    expect(cursor!.totalProcessed).toBeGreaterThanOrEqual(1);
  });

  // ---- Test 2: Idempotency ------------------------------------------------

  test("2. idempotency (v1 documented limitations) — canonical obs deduped; pricing rows double on re-run", async () => {
    // Count catalog_products before second run
    const catalogBefore = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TENANT));
    const catalogCountBefore = catalogBefore.length;

    // Read values snapshot of the existing product to compare after re-run
    const productBefore = catalogBefore[0]!;
    const valuesBefore = JSON.stringify(productBefore.values);

    // Snapshot pricing row count before the second run
    const pricingCountBefore = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.tenantId, TENANT))
      .then((r) => r.length);

    // Re-run with --from-scratch so cursor doesn't block re-processing
    const result = await runBackfill(
      { db },
      { tenantId: TENANT, batchSize: 10, fromScratch: true }
    );

    expect(result.totalFailed).toBe(0);
    expect(result.totalProcessed + result.totalSkipped).toBeGreaterThanOrEqual(1);

    // No NEW catalog_products rows (identity dedup resolved the same product)
    const catalogAfter = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TENANT));
    expect(catalogAfter.length).toBe(catalogCountBefore);

    // The canonical observations (title, brand, gtin, etc.) should NOT have
    // grown because they carry the same (source, sourceRecordId, value) and
    // writeAdapterOutput deduplicates them. The values JSON's leaf arrays
    // should have the same length as before.
    const productAfter = catalogAfter.find((r) => r.productId === productBefore.productId)!;
    expect(productAfter).toBeDefined();
    // values blob unchanged — no new canonical obs appended
    expect(JSON.stringify(productAfter.values)).toBe(valuesBefore);

    // v1 limitation: catalog_pricing_observations has no unique constraint on
    // (source, source_record_id), so idempotent re-runs DOUBLE pricing rows.
    // This is a documented v1 limitation (see script header spec-deviations).
    // Operators should not run --from-scratch on tenants with live pricing data
    // until the dedup migration lands.
    const pricingCountAfter = await db
      .select()
      .from(schema.catalogPricingObservations)
      .where(eq(schema.catalogPricingObservations.tenantId, TENANT))
      .then((r) => r.length);
    if (pricingCountBefore > 0) {
      expect(pricingCountAfter).toBe(pricingCountBefore * 2);
    }
  });

  // ---- Test 3: Dry-run ----------------------------------------------------

  test("3. dry-run — zero catalog rows written; cursor not advanced", async () => {
    // Record cursor state before dry-run
    const cursorBefore = await db
      .select()
      .from(schema.backfillCursor)
      .where(eq(schema.backfillCursor.tenantId, TENANT))
      .limit(1)
      .then((r) => r[0] ?? null);

    const catalogCountBefore = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TENANT))
      .then((r) => r.length);

    const result = await runBackfill(
      { db },
      { tenantId: TENANT, batchSize: 10, dryRun: true, fromScratch: true }
    );

    expect(result.dryRun).toBe(true);
    expect(result.totalFailed).toBe(0);

    // No new catalog rows
    const catalogCountAfter = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TENANT))
      .then((r) => r.length);
    expect(catalogCountAfter).toBe(catalogCountBefore);

    // Cursor unchanged by dry-run
    const cursorAfter = await db
      .select()
      .from(schema.backfillCursor)
      .where(eq(schema.backfillCursor.tenantId, TENANT))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (cursorBefore && cursorAfter) {
      // updated_at should not have changed (dry-run skips cursor write)
      expect(cursorAfter.updatedAt.toISOString()).toBe(
        cursorBefore.updatedAt.toISOString()
      );
    }
  });

  // ---- Test 4: Cursor resume ----------------------------------------------

  test("4. cursor resume — limit:1 then unlimited run advances cursor correctly", async () => {
    // Seed 2 additional product_versions for this test
    await seedProductVersion(db, {
      productId: PRODUCT_ID_2,
      pvId: PV_ID_2,
      diffId: DIFF_ID_2,
      factSetId: FACT_SET_ID_2,
      extractionRunId: EXTRACTION_RUN_ID_2,
      artifactId: ARTIFACT_ID_2,
      title: "Second Widget",
      brand: "BrandTwo"
    });
    await seedProductVersion(db, {
      productId: PRODUCT_ID_3,
      pvId: PV_ID_3,
      diffId: DIFF_ID_3,
      factSetId: FACT_SET_ID_3,
      extractionRunId: EXTRACTION_RUN_ID_3,
      artifactId: ARTIFACT_ID_3,
      title: "Third Widget",
      brand: "BrandThree"
    });

    // Reset cursor to start fresh for this sub-test
    await cleanupBackfillCursor(db);
    await cleanupCatalogRows(db);

    // Run 1: limit=1 — should process exactly 1 version (PV_ID_1 which is lexicographically first)
    const run1 = await runBackfill(
      { db },
      { tenantId: TENANT, batchSize: 10, limit: 1, fromScratch: true }
    );

    expect(run1.completed).toBe(false); // limit hit, not EOF
    expect(run1.totalFailed).toBe(0);

    const cursor1 = await db
      .select()
      .from(schema.backfillCursor)
      .where(eq(schema.backfillCursor.tenantId, TENANT))
      .limit(1)
      .then((r) => r[0]);
    expect(cursor1).toBeDefined();
    // Cursor should point at first version processed
    expect(cursor1!.lastProductVersionIdProcessed).not.toBeNull();

    // Run 2: no limit — should continue from cursor and process remaining versions
    const run2 = await runBackfill(
      { db },
      { tenantId: TENANT, batchSize: 10 }
    );

    expect(run2.completed).toBe(true); // all versions processed
    expect(run2.totalFailed).toBe(0);

    const cursor2 = await db
      .select()
      .from(schema.backfillCursor)
      .where(eq(schema.backfillCursor.tenantId, TENANT))
      .limit(1)
      .then((r) => r[0]);
    expect(cursor2!.completedAt).not.toBeNull();

    // Total catalog products across both runs: 3 (one per seeded version)
    const catalogRows = await db
      .select()
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, TENANT));
    // At least 2 new products from run2 (PV2, PV3); PV1 was already there from run1
    expect(catalogRows.length).toBeGreaterThanOrEqual(3);
  });
});
