#!/usr/bin/env bun
// HISTORICAL ARTIFACT — Phase 7 backfill tooling.
//
// This script was used during the Phase 7 (Backfill + dual-write soak) window
// to migrate legacy product_versions data into the new catalog_products schema.
// After Phase 8 cutover renamed legacy tables to _legacy_* and Phase 9.1 dropped
// them, this script no longer has runnable purpose — its source tables are gone.
//
// Kept in-tree as an audit artifact (Drizzle schemas for legacy tables still
// exist in packages/db/src/schema/products.ts to support the type references).
// DO NOT RUN against production post-cutover.
//
// Run: bun --env-file=../../.env run scripts/validate-backfill.ts \
//        --tenant-id <uuid> [options]
//
// Catalog redesign Phase 7 — Task 7.2 — Backfill validation harness.
//
// For each migrated catalog_products row (status='active', revision tagged
// 'migration_backfill'), validates that the backfill produced zero data loss
// on the required fields: title, brand, gtin, primary_pricing.
//
// FK chain navigated to reach extracted_facts from catalog_products:
//   catalog_product_revisions.raw_payload->>'product_version_id'
//     → product_versions.proposed_diff_id
//       → proposed_diffs.source_fact_set_id
//         → extracted_fact_sets.id
//           → extracted_facts.fact_set_id
//
// Design decisions:
//  - Source of truth for "legacy SkuJson": recomputed via convertFromFacts()
//    from the extracted_facts rows linked through the revision's raw_payload
//    provenance. This avoids re-reading product_versions for every product
//    and respects the stored provenance chain.
//  - winning_values projection: reads catalog_products.winning_values JSONB
//    using the same shape the sync reconciler writes:
//      winning_values[attr][channel][locale] = <winning value>
//    We look at all channels/locales but prefer "_unscoped"/"_unscoped" for
//    deterministic comparison against the unscoped backfill observations.
//  - primary_pricing: read from catalog_pricing_current (strongest source —
//    avoids eventual-consistency lag). Compare currency + primaryAmount rounded
//    to 4 decimal places. Tier structures are compared after JSON normalization.
//  - Images: SKIPPED in v1 — consistent with Task 7.1 deferral. The canonical
//    attribute code for image arrays is not yet defined in attribute_definitions.
//  - Variants: SKIPPED in v1 — backfill targets parent metadata only.
//  - Allowed deltas: keys present ONLY in new schema (_field_source,
//    _extraction_meta, _channel, _locale) do not constitute failures.
//  - baseUrl for convertFromFacts: set to empty string. The validator reads
//    already-normalised facts; URL normalisation in image paths is irrelevant
//    because images are skipped.
//
// Exit codes:
//   0  Validation completed (use --strict to fail on loss)
//   1  Bad input, or in --strict mode: at least one required-field loss
//   2  Runtime error (DB connection, unrecoverable failure)

import { eq, and, sql } from "drizzle-orm";
import { createDb, schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import { convertFromFacts } from "@aonex/ingestion-enrichment";
import type { SkuJson } from "@aonex/ingestion-enrichment";
import { writeFile, rename } from "node:fs/promises";

// ---- Types -----------------------------------------------------------------

export interface ValidationDeps {
  db: DrizzleClient;
}

export interface ValidationOptions {
  tenantId: string;
  limit?: number;
  sampleRate?: number;
  strict?: boolean;
}

export interface ProductValidationResult {
  product_id: string;
  pass: boolean;
  failures: Array<{ field: string; legacy: unknown; new: unknown; reason: string }>;
}

export interface ValidationReport {
  tenantId: string;
  totalScanned: number;
  totalPassed: number;
  /** Products with at least one DATA LOSS issue (REQUIRED_FIELDS). */
  totalFailed: number;
  /** Products that failed to compare due to DB / SkuJson errors. */
  totalErrors: number;
  failuresByField: Record<string, number>;
  /** First 5 failing products per field, merged into a deduplicated list. */
  sampleFailures: ProductValidationResult[];
  generatedAt: string;
  // Invariant: totalScanned === totalPassed + totalFailed + totalErrors
}

interface ParsedArgs {
  tenantId: string;
  limit: number | undefined;
  sampleRate: number;
  outputPath: string | undefined;
  strict: boolean;
}

// ---- Help / usage ----------------------------------------------------------

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: bun --env-file=../../.env run scripts/validate-backfill.ts --tenant-id <uuid> [options]

Validate the catalog backfill produced zero data loss on required fields.

For each migrated catalog_products row:
  1. Recompute legacy SkuJson from extracted_facts via convertFromFacts.
  2. Project catalog_products.winning_values into an equivalent shape.
  3. Compare title, brand, gtin, primary_pricing (zero-loss required).
  4. Report per-field failure counts + sample examples.

Required:
  --tenant-id <uuid>      Tenant scope.

Options:
  --limit <n>             Cap products validated (testing).
  --sample-rate <f>       Random fraction in [0,1]. Default 1.0 (all).
  --output <path>         Write full JSON report to this file.
  --strict                Exit 1 on any required-field loss. Default: exit 0 with warning.
  --help, -h              Print this and exit.

Output: summary to stdout, optional full JSON report to --output.

Exit codes:
  0  Validation completed (use --strict to fail on loss)
  1  Bad input, or in --strict mode: at least one required-field loss
  2  Runtime error`);
}

// ---- Arg parsing -----------------------------------------------------------

function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function parsePositiveInt(name: string, raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer; got: ${raw}`);
  }
  return n;
}

function parseFloat01(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`${name} must be a number in [0, 1]; got: ${raw}`);
  }
  return n;
}

/**
 * Consume `--flag value` or `--flag=value` from argv at position i.
 */
function take(
  argv: string[],
  name: string,
  i: number
): { value: string; consumed: number } {
  const arg = argv[i]!;
  const eqIdx = arg.indexOf("=");
  if (eqIdx >= 0) {
    const value = arg.slice(eqIdx + 1);
    if (value.length === 0) {
      throw new Error(`${name} requires a value`);
    }
    return { value, consumed: 1 };
  }
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return { value: next, consumed: 2 };
}

function parseArgs(argv: string[]): ParsedArgs {
  let tenantId: string | undefined;
  let limit: number | undefined;
  let sampleRate = 1.0;
  let outputPath: string | undefined;
  let strict = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--tenant-id" || arg.startsWith("--tenant-id=")) {
      const { value, consumed } = take(argv, "--tenant-id", i);
      tenantId = value;
      i += consumed - 1;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const { value, consumed } = take(argv, "--limit", i);
      limit = parsePositiveInt("--limit", value);
      i += consumed - 1;
    } else if (arg === "--sample-rate" || arg.startsWith("--sample-rate=")) {
      const { value, consumed } = take(argv, "--sample-rate", i);
      sampleRate = parseFloat01("--sample-rate", value);
      i += consumed - 1;
    } else if (arg === "--output" || arg.startsWith("--output=")) {
      const { value, consumed } = take(argv, "--output", i);
      outputPath = value;
      i += consumed - 1;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!tenantId) throw new Error("--tenant-id is required");
  if (!looksLikeUuid(tenantId)) {
    throw new Error(`--tenant-id must be a UUID; got: ${tenantId}`);
  }

  return { tenantId, limit, sampleRate, outputPath, strict };
}

// ---- Comparison helpers ----------------------------------------------------

/**
 * Normalize a scalar value for comparison:
 *  - Strings: trim whitespace, lowercase.
 *  - Nullish: return null.
 *  - Numbers: return as-is (handled separately for rounding in pricing).
 *  - Other: return as-is.
 */
export function normalizeForCompare(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim().toLowerCase();
  return v;
}

/**
 * Compare a required scalar field (title, brand, gtin) between legacy SkuJson
 * and the new winning_values projection. Both sides are normalized before comparison.
 */
export function comparePrimary(
  field: string,
  legacy: unknown,
  newVal: unknown
): { equal: boolean; reason?: string } {
  const legacyN = normalizeForCompare(legacy);
  const newN = normalizeForCompare(newVal);

  // Both absent — considered equal (no data on either side)
  if (legacyN === null && newN === null) {
    return { equal: true };
  }

  // Legacy has data but new does not — this is a loss
  if (legacyN !== null && newN === null) {
    return {
      equal: false,
      reason: `${field}: present in legacy SkuJson but missing in new catalog_products`
    };
  }

  // New has data but legacy does not — allowed delta (new schema is richer)
  if (legacyN === null && newN !== null) {
    return { equal: true };
  }

  // Both present — strict equality after normalization
  if (legacyN !== newN) {
    return {
      equal: false,
      reason: `${field}: values differ (legacy="${legacyN}" new="${newN}")`
    };
  }

  return { equal: true };
}

/**
 * Compare primary_pricing between the legacy SkuJson.pricing block and the
 * catalog_pricing_current row(s).
 *
 * Strategy:
 *  - If legacy has no pricing (list_price and sale_price both null, or null currency):
 *    considered equal — no pricing data to lose.
 *  - If legacy has pricing but new has no catalog_pricing_current rows:
 *    treated as a loss.
 *  - If both have pricing: compare currency (exact after lowercase trim) and
 *    the effective amount (sale_price ?? list_price), rounded to 4 decimal places.
 *    Tier structure comparison is secondary — we don't fail on tier shape
 *    differences because the backfill stores a single base tier, and the
 *    pricing_current table could later get additional tiers from live sources.
 */
export function comparePricing(
  legacyPricing: SkuJson["pricing"],
  newPricingRows: Array<{ currency: string; primaryAmount: string | null; tiers: unknown }>
): { equal: boolean; reason?: string } {
  const legacyAmount = legacyPricing.sale_price ?? legacyPricing.list_price;
  const legacyCurrency = legacyPricing.currency;

  const hasLegacyPricing =
    legacyAmount !== null && legacyCurrency !== null;

  if (!hasLegacyPricing) {
    // Nothing to lose
    return { equal: true };
  }

  if (newPricingRows.length === 0) {
    return {
      equal: false,
      reason: `primary_pricing: legacy has amount=${legacyAmount} currency=${legacyCurrency} but no catalog_pricing_current rows found`
    };
  }

  // Find a pricing row that matches the currency
  const currencyNorm = (s: string) => s.trim().toUpperCase();
  const legacyCurrencyN = currencyNorm(legacyCurrency);
  const matching = newPricingRows.filter(
    (r) => currencyNorm(r.currency) === legacyCurrencyN
  );

  if (matching.length === 0) {
    const currencies = newPricingRows.map((r) => r.currency).join(", ");
    return {
      equal: false,
      reason: `primary_pricing: legacy currency ${legacyCurrencyN} not found in new rows (found: ${currencies})`
    };
  }

  // Compare amount against the first matching row's primaryAmount (rounded to 4 dp)
  const row = matching[0]!;
  if (row.primaryAmount === null) {
    return {
      equal: false,
      reason: `primary_pricing: new catalog_pricing_current.primary_amount is NULL for currency ${legacyCurrencyN}`
    };
  }

  const legacyRounded = Math.round(legacyAmount * 10000) / 10000;
  const newRounded = Math.round(Number(row.primaryAmount) * 10000) / 10000;

  if (legacyRounded !== newRounded) {
    return {
      equal: false,
      reason: `primary_pricing: amount mismatch for currency ${legacyCurrencyN} (legacy=${legacyRounded} new=${newRounded})`
    };
  }

  return { equal: true };
}

/**
 * Images comparison is deferred in v1 (see Task 7.1 deferral). Returning
 * `{ equal: true }` here keeps the comparison interface uniform with the other
 * comparators and makes it explicit that no comparison happened — vs. silently
 * omitting images from the field loop.
 *
 * TODO(phase-7+): when backfill writes image observations, implement
 * URL-set equality comparison here.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function compareImages(_legacyImages: unknown, _newImages: unknown): { equal: boolean } {
  return { equal: true };
}

// ---- winning_values projection helper --------------------------------------

/**
 * Extract the winning scalar for a given attribute code from the
 * `winning_values` JSONB.
 *
 * winning_values shape (from sync reconciler):
 *   { [attr]: { [channel]: { [locale]: <winning value> } } }
 *
 * Preference order for scalar extraction:
 *   1. "_unscoped" channel → "_unscoped" locale (backfill writes these scopes)
 *   2. Any first channel → first locale (fallback for other sources)
 *
 * Returns null if the attribute is absent or no leaf value found.
 */
export function extractWinningValue(
  winningValues: Record<string, unknown>,
  attr: string
): unknown {
  const attrBlock = winningValues[attr];
  if (!attrBlock || typeof attrBlock !== "object" || Array.isArray(attrBlock)) {
    return null;
  }
  const byChannel = attrBlock as Record<string, Record<string, unknown>>;

  // Prefer _unscoped channel
  const preferredChannels = Object.keys(byChannel).includes("_unscoped")
    ? ["_unscoped", ...Object.keys(byChannel).filter((c) => c !== "_unscoped")]
    : Object.keys(byChannel);

  for (const channel of preferredChannels) {
    const byLocale = byChannel[channel];
    if (!byLocale || typeof byLocale !== "object") continue;
    // Prefer _unscoped locale
    const preferredLocales = Object.keys(byLocale).includes("_unscoped")
      ? ["_unscoped", ...Object.keys(byLocale).filter((l) => l !== "_unscoped")]
      : Object.keys(byLocale);

    for (const locale of preferredLocales) {
      const v = (byLocale as Record<string, unknown>)[locale];
      if (v !== null && v !== undefined) return v;
    }
  }

  return null;
}

// ---- FK chain helpers -------------------------------------------------------

/**
 * Fetch extracted_facts for a product via the raw_payload provenance chain
 * stored by the backfill in catalog_product_revisions.
 *
 * Chain:
 *   catalog_product_revisions.raw_payload->>'product_version_id'
 *     → product_versions.proposed_diff_id
 *       → proposed_diffs.source_fact_set_id
 *         → extracted_facts.fact_set_id
 *
 * Returns empty array if any link is missing (e.g. non-backfilled product).
 */
async function fetchFactsForProduct(
  db: DrizzleClient,
  productId: string
): Promise<typeof schema.linkIngestionTraceFacts.$inferSelect[]> {
  // Step 1: find the backfill revision and extract product_version_id from raw_payload
  const revRows = await db.execute<{ product_version_id: string | null }>(
    sql`
      SELECT raw_payload->>'product_version_id' AS product_version_id
      FROM catalog_product_revisions
      WHERE product_id = ${productId}
        AND revision_reason = 'migration_backfill'
      ORDER BY revision_id DESC
      LIMIT 1
    `
  );

  const pvId = revRows.rows[0]?.product_version_id;
  if (!pvId) return [];

  // Step 2: look up the product_version to get proposed_diff_id
  const pvRows = await db
    .select({ proposedDiffId: schema.productVersions.proposedDiffId })
    .from(schema.productVersions)
    .where(eq(schema.productVersions.id, pvId))
    .limit(1);

  const proposedDiffId = pvRows[0]?.proposedDiffId;
  if (!proposedDiffId) return [];

  // Step 3: look up proposed_diff to get source_fact_set_id
  const diffRows = await db
    .select({ sourceFactSetId: schema.proposedDiffs.sourceFactSetId })
    .from(schema.proposedDiffs)
    .where(eq(schema.proposedDiffs.id, proposedDiffId))
    .limit(1);

  const factSetId = diffRows[0]?.sourceFactSetId;
  if (!factSetId) return [];

  // Step 4: fetch facts
  const facts = await db
    .select()
    .from(schema.linkIngestionTraceFacts)
    .where(eq(schema.linkIngestionTraceFacts.factSetId, factSetId));

  return facts;
}

/**
 * Fetch catalog_pricing_current rows for a product (all channels + locales).
 */
async function fetchPricingCurrent(
  db: DrizzleClient,
  productId: string
): Promise<Array<{ currency: string; primaryAmount: string | null; tiers: unknown }>> {
  const rows = await db
    .select({
      currency: schema.catalogPricingCurrent.currency,
      primaryAmount: schema.catalogPricingCurrent.primaryAmount,
      tiers: schema.catalogPricingCurrent.tiers
    })
    .from(schema.catalogPricingCurrent)
    .where(eq(schema.catalogPricingCurrent.productId, productId));

  return rows.map((r) => ({
    currency: r.currency,
    primaryAmount: r.primaryAmount !== null && r.primaryAmount !== undefined
      ? String(r.primaryAmount)
      : null,
    tiers: r.tiers
  }));
}

// ---- Validate one product ---------------------------------------------------

/**
 * Validate a single catalog_products row against its legacy SkuJson.
 * Returns a ProductValidationResult with pass/fail and per-field failure details.
 */
async function validateProduct(
  db: DrizzleClient,
  product: typeof schema.catalogProducts.$inferSelect
): Promise<ProductValidationResult> {
  const productId = product.productId;
  const winningValues = (product.winningValues ?? {}) as Record<string, unknown>;

  // 1. Fetch extracted_facts via the backfill FK chain
  const facts = await fetchFactsForProduct(db, productId);

  // 2. Recompute legacy SkuJson from facts (baseUrl irrelevant: images skipped)
  const legacySku: SkuJson = convertFromFacts(facts, "");

  // 3. Fetch catalog_pricing_current rows
  const pricingRows = await fetchPricingCurrent(db, productId);

  // 4. Compare required fields
  const failures: ProductValidationResult["failures"] = [];

  // --- title ---
  const legacyTitle = legacySku.title;
  const newTitle = extractWinningValue(winningValues, "title");
  const titleCmp = comparePrimary("title", legacyTitle, newTitle);
  if (!titleCmp.equal) {
    failures.push({
      field: "title",
      legacy: legacyTitle,
      new: newTitle,
      reason: titleCmp.reason ?? "title: mismatch"
    });
  }

  // --- brand ---
  const legacyBrand = legacySku.brand;
  const newBrand = extractWinningValue(winningValues, "brand");
  const brandCmp = comparePrimary("brand", legacyBrand, newBrand);
  if (!brandCmp.equal) {
    failures.push({
      field: "brand",
      legacy: legacyBrand,
      new: newBrand,
      reason: brandCmp.reason ?? "brand: mismatch"
    });
  }

  // --- gtin ---
  const legacyGtin = legacySku.gtin;
  const newGtin = extractWinningValue(winningValues, "gtin");
  const gtinCmp = comparePrimary("gtin", legacyGtin, newGtin);
  if (!gtinCmp.equal) {
    failures.push({
      field: "gtin",
      legacy: legacyGtin,
      new: newGtin,
      reason: gtinCmp.reason ?? "gtin: mismatch"
    });
  }

  // --- primary_pricing ---
  const pricingCmp = comparePricing(legacySku.pricing, pricingRows);
  if (!pricingCmp.equal) {
    failures.push({
      field: "primary_pricing",
      legacy: legacySku.pricing,
      new: pricingRows,
      reason: pricingCmp.reason ?? "primary_pricing: mismatch"
    });
  }

  // --- images: SKIPPED in v1 ---
  // compareImages() exists as a typed slot (see the stub above) but is not
  // called here. The backfill intentionally writes no image data to
  // winning_values, so calling it now would produce false positives.
  // See Task 7.1 deferral for the canonical attribute code discussion.

  return {
    product_id: productId,
    pass: failures.length === 0,
    failures
  };
}

// ---- runValidation (exported for tests) ------------------------------------

/**
 * Validate the catalog backfill for a single tenant.
 *
 * Only validates catalog_products rows that have a 'migration_backfill'
 * revision — non-backfilled products are ignored so live-written products
 * don't pollute the report.
 *
 * @returns {@link ValidationReport} — aggregate stats + sample failures.
 */
export async function runValidation(
  deps: ValidationDeps,
  options: ValidationOptions
): Promise<ValidationReport> {
  const { db } = deps;
  const { tenantId, limit, sampleRate = 1.0 } = options;

  const log = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[validate-backfill] ${msg}`);
  };
  const warn = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.error(`[validate-backfill] WARN: ${msg}`);
  };

  log(`Starting validation for tenant=${tenantId} sampleRate=${sampleRate} limit=${limit ?? "none"}`);

  // Find catalog_products that have at least one 'migration_backfill' revision.
  // We JOIN via a subquery on catalog_product_revisions to get only backfilled products.
  // Use raw SQL for the subquery join since Drizzle ORM makes scalar subqueries verbose.
  // Note: the backfill writes status='draft' (catalog-write default). We do NOT
  // filter by status here — the revision_reason='migration_backfill' filter is
  // the correct discriminant. Filtering by status='active' would silently skip
  // all backfilled products and produce a misleading all-pass report.
  const backfilledRows = await db.execute<{ product_id: string }>(
    sql`
      SELECT DISTINCT cp.product_id
      FROM catalog_products cp
      WHERE cp.tenant_id = ${tenantId}
        AND EXISTS (
          SELECT 1
          FROM catalog_product_revisions cpr
          WHERE cpr.product_id = cp.product_id
            AND cpr.revision_reason = 'migration_backfill'
        )
      ORDER BY cp.product_id
    `
  );

  let productIds = backfilledRows.rows.map((r) => r.product_id);

  log(`Found ${productIds.length} backfilled products for tenant=${tenantId}`);

  // Apply sample rate — deterministic stride sampling: keep every (1/sampleRate)-th
  // product by index. This is reproducible across runs with the same args (unlike
  // Math.random), which lets operators confirm the same subset from a CI log.
  if (sampleRate < 1.0) {
    const stride = Math.floor(1 / sampleRate);
    productIds = productIds.filter((_, i) => i % stride === 0);
    log(`Sampled down to ${productIds.length} products at rate=${sampleRate} (stride=${stride})`);
  }

  // Apply limit
  if (limit !== undefined && productIds.length > limit) {
    productIds = productIds.slice(0, limit);
    log(`Capped to ${productIds.length} products (--limit=${limit})`);
  }

  // Per-field sample failure buckets (capped at 5 per field)
  const sampleFailuresByField = new Map<string, ProductValidationResult[]>();
  const allResults: ProductValidationResult[] = [];
  let totalScanned = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalErrors = 0;
  const failuresByField: Record<string, number> = {};

  const REQUIRED_FIELDS = ["title", "brand", "gtin", "primary_pricing"];

  for (const productId of productIds) {
    // Fetch the full catalog_products row
    const rows = await db
      .select()
      .from(schema.catalogProducts)
      .where(
        and(
          eq(schema.catalogProducts.productId, productId),
          eq(schema.catalogProducts.tenantId, tenantId)
        )
      )
      .limit(1);

    const product = rows[0];
    if (!product) {
      warn(`Product ${productId} not found in catalog_products — skipping`);
      continue;
    }

    totalScanned++;

    let result: ProductValidationResult;
    try {
      result = await validateProduct(db, product);
    } catch (err) {
      warn(`Error validating product ${productId}: ${err instanceof Error ? err.message : String(err)}`);
      result = {
        product_id: productId,
        pass: false,
        failures: [{
          field: "_runtime_error",
          legacy: null,
          new: null,
          reason: `Runtime error during validation: ${err instanceof Error ? err.message : String(err)}`
        }]
      };
    }

    allResults.push(result);

    if (result.pass) {
      totalPassed++;
    } else {
      // Distinguish runtime errors (_runtime_error) from data-loss failures
      const isRuntimeError = result.failures.some((f) => f.field === "_runtime_error");
      if (isRuntimeError) {
        totalErrors++;
      } else {
        totalFailed++;

        // Accumulate per-field counts and samples
        for (const f of result.failures) {
          if (REQUIRED_FIELDS.includes(f.field)) {
            failuresByField[f.field] = (failuresByField[f.field] ?? 0) + 1;

            const bucket = sampleFailuresByField.get(f.field) ?? [];
            if (bucket.length < 5 && !bucket.some((r) => r.product_id === result.product_id)) {
              bucket.push(result);
            }
            sampleFailuresByField.set(f.field, bucket);
          }
        }
      }
    }
  }

  // Merge sample failures (unique products, ordered by field first seen)
  const seenProductIds = new Set<string>();
  const sampleFailures: ProductValidationResult[] = [];
  for (const bucket of sampleFailuresByField.values()) {
    for (const r of bucket) {
      if (!seenProductIds.has(r.product_id)) {
        seenProductIds.add(r.product_id);
        sampleFailures.push(r);
      }
    }
  }

  const report: ValidationReport = {
    tenantId,
    totalScanned,
    totalPassed,
    totalFailed,
    totalErrors,
    failuresByField,
    sampleFailures,
    generatedAt: new Date().toISOString()
  };

  log(`Validation complete: tenant=${tenantId} scanned=${totalScanned} passed=${totalPassed} failed=${totalFailed} errors=${totalErrors}`);
  if (totalFailed > 0) {
    warn(`Required-field losses detected. failuresByField=${JSON.stringify(failuresByField)}`);
    warn(`images comparison skipped, see Task 7.1 limitations`);
  } else {
    log(`Zero required-field losses. images comparison skipped, see Task 7.1 limitations.`);
  }

  return report;
}

// ---- CLI entrypoint --------------------------------------------------------

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[validate-backfill] ${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // eslint-disable-next-line no-console
    console.error("[validate-backfill] DATABASE_URL is required");
    process.exit(1);
  }

  const { client, close } = createDb(databaseUrl);
  try {
    const report = await runValidation(
      { db: client },
      {
        tenantId: args.tenantId,
        limit: args.limit,
        sampleRate: args.sampleRate,
        strict: args.strict
      }
    );

    // Print summary to stdout
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      tenantId: report.tenantId,
      totalScanned: report.totalScanned,
      totalPassed: report.totalPassed,
      totalFailed: report.totalFailed,
      totalErrors: report.totalErrors,
      failuresByField: report.failuresByField,
      sampleFailures: report.sampleFailures,
      generatedAt: report.generatedAt
    }, null, 2));

    // Write full JSON report if --output specified.
    // Use a write-to-tmp-then-rename pattern so a killed process cannot leave
    // a truncated file at the final path. rename() is atomic on POSIX
    // (same filesystem), so readers always see a complete file or nothing.
    if (args.outputPath) {
      const tmpPath = `${args.outputPath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(report, null, 2), "utf-8");
      await rename(tmpPath, args.outputPath);
      // eslint-disable-next-line no-console
      console.log(`[validate-backfill] Full report written to ${args.outputPath}`);
    }

    // Exit codes
    if (report.totalFailed > 0 && args.strict) {
      // eslint-disable-next-line no-console
      console.error(`[validate-backfill] --strict mode: ${report.totalFailed} product(s) with required-field loss. Exiting 1.`);
      process.exit(1);
    }

    if (report.totalFailed > 0 && !args.strict) {
      // eslint-disable-next-line no-console
      console.error(`[validate-backfill] WARNING: ${report.totalFailed} product(s) with required-field loss. Run with --strict to fail hard.`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[validate-backfill] Failed:", err);
    process.exit(2);
  } finally {
    await close();
  }
}

// Only run as CLI entrypoint — not when imported by tests.
if (import.meta.main) {
  await main();
}
