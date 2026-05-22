#!/usr/bin/env bun
// Run: bun --env-file=../../.env run scripts/spot-check.ts \
//        --tenant-id <uuid> [options]
//
// Catalog redesign Phase 7 — Task 7.4 — Spot-check report tool.
//
// Samples backfilled catalog_products rows (those with a
// revision_reason='migration_backfill' revision) and renders a side-by-side
// legacy SkuJson vs new-schema view as a self-contained HTML report for human
// review during the Phase 7 dual-write soak.
//
// Sampling:
//   - Default: random per run (ORDER BY random() in Postgres).
//   - With --seed: deterministic via Postgres setseed(seed/2147483648.0) before
//     ORDER BY random() — identical results for the same seed + data snapshot.
//
// Per-field comparison uses the same helpers exported from validate-backfill.ts:
//   normalizeForCompare, comparePrimary, comparePricing, extractWinningValue.
// Additional fields (images, description, weight) are compared best-effort
// for human review but do not gate pass/fail status.
//
// HTML output:
//   - Self-contained; no external CSS or JS.
//   - Written atomically (tmp + rename) so a kill mid-write cannot produce a
//     truncated file at the target path.
//   - Products grouped into three sections:
//       "Possible losses"  (a required field is absent in new but present in legacy)
//       "Differences"      (a field value differs between legacy and new)
//       "All-match"        (every compared field matches)
//
// Exit codes:
//   0  Success
//   1  Bad input
//   2  Runtime error

import { eq, and, sql } from "drizzle-orm";
import { createDb, schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import { convertFromFacts } from "@aonex/ingestion-enrichment";
import type { SkuJson } from "@aonex/ingestion-enrichment";
import { writeFile, rename } from "node:fs/promises";
import {
  normalizeForCompare,
  comparePrimary,
  comparePricing,
  extractWinningValue
} from "./validate-backfill.js";
// CROSS-APP: relative path into apps/api — update if api is ever extracted to a package.
import { readProductTrace, PRODUCT_NOT_FOUND } from "../../api/src/services/new-catalog-trace.js";
import type { ProductTraceResult } from "../../api/src/services/new-catalog-trace.js";

// ---- Types -----------------------------------------------------------------

export interface SpotCheckDeps {
  db: DrizzleClient;
}

export interface SpotCheckOptions {
  tenantId: string;
  sampleSize?: number;
  outputPath?: string;
  /** Integer seed for deterministic Postgres random() sampling. */
  seed?: number;
  /** Override for the report timestamp. Used by tests to get deterministic HTML. */
  _timestampOverride?: string;
}

type FieldStatus = "match" | "diff" | "legacy-only" | "new-only";

interface FieldComparison {
  field: string;
  legacyValue: unknown;
  newValue: unknown;
  status: FieldStatus;
}

export interface ProductSpotCheckResult {
  productId: string;
  merchantId: string;
  legacySku: SkuJson;
  newTrace: ProductTraceResult | null;
  perField: FieldComparison[];
  /** Worst classification across all fields. */
  worstStatus: "match" | "diff" | "loss";
}

export interface SpotCheckReport {
  tenantId: string;
  sampleSize: number;
  seed: number;
  generatedAt: string;
  totalSampled: number;
  allMatch: number;
  withDiffs: number;
  withLosses: number;
  products: ProductSpotCheckResult[];
}

interface ParsedArgs {
  tenantId: string;
  sampleSize: number;
  outputPath: string;
  seed: number;
}

// ---- Help / usage ----------------------------------------------------------

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: bun apps/worker/scripts/spot-check.ts --tenant-id <uuid> [options]

Render a side-by-side legacy vs new-schema spot-check report for human review
during the Phase 7 dual-write soak.

Samples backfilled products (revision_reason='migration_backfill'), fetches both
the legacy SkuJson view and the new winning_values/catalog_pricing_current view,
and outputs an HTML report grouping products by: All-match / Differences / Possible losses.

Required:
  --tenant-id <uuid>      Tenant scope.

Options:
  --sample-size <n>       Number of products to sample. Default 100, max 1000.
  --output <path>         Write HTML report here. Default ./spot-check-report.html.
  --seed <n>              Integer (any value) seed for deterministic sampling (Postgres setseed).
                          Default: non-deterministic (Date.now()).
  --help, -h              Print this and exit.

Exit codes:
  0  Success
  1  Bad input
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

/**
 * Parse any safe integer (positive, zero, or negative).
 * Used for --seed because Postgres setseed() accepts the full [-1, 1] range
 * and seed=0 is a meaningful value (the default Postgres state).
 */
function parseAnyInt(rawArg: string, name: string): number {
  const raw = rawArg.trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
    throw new Error(`${name} must be an integer (any value); got: ${rawArg}`);
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
  let sampleSize = 100;
  let outputPath = "./spot-check-report.html";
  let seed = Date.now();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--tenant-id" || arg.startsWith("--tenant-id=")) {
      const { value, consumed } = take(argv, "--tenant-id", i);
      tenantId = value;
      i += consumed - 1;
    } else if (arg === "--sample-size" || arg.startsWith("--sample-size=")) {
      const { value, consumed } = take(argv, "--sample-size", i);
      const n = parsePositiveInt("--sample-size", value);
      sampleSize = Math.min(Math.max(1, n), 1000);
      i += consumed - 1;
    } else if (arg === "--output" || arg.startsWith("--output=")) {
      const { value, consumed } = take(argv, "--output", i);
      outputPath = value;
      i += consumed - 1;
    } else if (arg === "--seed" || arg.startsWith("--seed=")) {
      const { value, consumed } = take(argv, "--seed", i);
      seed = parseAnyInt(value, "--seed");
      i += consumed - 1;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!tenantId) throw new Error("--tenant-id is required");
  if (!looksLikeUuid(tenantId)) {
    throw new Error(`--tenant-id must be a UUID; got: ${tenantId}`);
  }

  return { tenantId, sampleSize, outputPath, seed };
}

// ---- HTML escaping ---------------------------------------------------------

/**
 * Escape user-controlled strings before embedding in HTML context.
 * CRITICAL: must be used for every interpolated value.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Truncate a string value to maxLen characters with an ellipsis marker.
 */
function truncate(s: string, maxLen = 200): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}

/**
 * Render a value as a safe, human-readable HTML snippet for the report table.
 * Objects are JSON-stringified; strings are truncated.
 */
function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "<em>(none)</em>";
  const str =
    typeof v === "object"
      ? truncate(JSON.stringify(v), 200)
      : truncate(String(v), 200);
  return escapeHtml(str);
}

// ---- Per-field comparison --------------------------------------------------

/**
 * Classify the comparison between a legacy value and a new value into a
 * FieldStatus label for the report.
 *
 * Rules:
 *   - Both absent  → "match"  (no data on either side, nothing to lose)
 *   - Legacy present, new absent → "legacy-only"  (potential loss)
 *   - Legacy absent, new present → "new-only"  (new schema is richer — ok)
 *   - Both present, normalized-equal → "match"
 *   - Both present, normalized-different → "diff"
 */
function classifyField(legacy: unknown, newVal: unknown): FieldStatus {
  const legacyN = normalizeForCompare(legacy);
  const newN = normalizeForCompare(newVal);
  if (legacyN === null && newN === null) return "match";
  if (legacyN !== null && newN === null) return "legacy-only";
  if (legacyN === null && newN !== null) return "new-only";
  return legacyN === newN ? "match" : "diff";
}

/**
 * Map a FieldStatus to the worst-case product classification.
 * "legacy-only" is treated as a possible loss.
 */
function statusToProductClass(
  s: FieldStatus
): "match" | "diff" | "loss" {
  if (s === "legacy-only") return "loss";
  if (s === "diff") return "diff";
  return "match";
}

const STATUS_ORDER: Record<FieldStatus, number> = {
  "legacy-only": 0,
  diff: 1,
  "new-only": 2,
  match: 3
};

// ---- FK chain helpers -------------------------------------------------------

/**
 * Fetch extracted_facts for a product via the raw_payload provenance chain.
 * Same chain used by validate-backfill.ts.
 */
async function fetchFactsForProduct(
  db: DrizzleClient,
  productId: string
): Promise<typeof schema.linkIngestionTraceFacts.$inferSelect[]> {
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

  const pvRows = await db
    .select({ proposedDiffId: schema.productVersions.proposedDiffId })
    .from(schema.productVersions)
    .where(eq(schema.productVersions.id, pvId))
    .limit(1);

  const proposedDiffId = pvRows[0]?.proposedDiffId;
  if (!proposedDiffId) return [];

  const diffRows = await db
    .select({ sourceFactSetId: schema.proposedDiffs.sourceFactSetId })
    .from(schema.proposedDiffs)
    .where(eq(schema.proposedDiffs.id, proposedDiffId))
    .limit(1);

  const factSetId = diffRows[0]?.sourceFactSetId;
  if (!factSetId) return [];

  return db
    .select()
    .from(schema.linkIngestionTraceFacts)
    .where(eq(schema.linkIngestionTraceFacts.factSetId, factSetId));
}

/**
 * Fetch catalog_pricing_current rows for a product (all currencies).
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
    primaryAmount:
      r.primaryAmount !== null && r.primaryAmount !== undefined
        ? String(r.primaryAmount)
        : null,
    tiers: r.tiers
  }));
}

// ---- Spot-check one product ------------------------------------------------

/**
 * Build per-field comparison for a single product.
 * Fields compared: title, brand, gtin, primary_pricing, description, weight, images, category.
 * Required-field status (title, brand, gtin, primary_pricing) informs product classification.
 */
async function spotCheckProduct(
  db: DrizzleClient,
  product: typeof schema.catalogProducts.$inferSelect
): Promise<ProductSpotCheckResult> {
  const productId = product.productId;
  const winningValues = (product.winningValues ?? {}) as Record<string, unknown>;

  // Legacy view
  const facts = await fetchFactsForProduct(db, productId);
  const legacySku: SkuJson = convertFromFacts(facts, "");

  // New view — fetch trace (merchant is on the product row)
  let newTrace: ProductTraceResult | null = null;
  try {
    const traceResult = await readProductTrace(db, {
      tenantId: product.tenantId,
      merchantId: product.merchantId,
      productId,
      revisionsLimit: 1,
      eventsLimit: 1,
      observationsLimit: 10
    });
    if (traceResult !== PRODUCT_NOT_FOUND) {
      newTrace = traceResult;
    }
  } catch {
    // Trace read failures are non-fatal for the spot-check report
  }

  // Pricing rows for required-field comparison
  const pricingRows = await fetchPricingCurrent(db, productId);

  // ---- Per-field comparisons -----------------------------------------------
  const perField: FieldComparison[] = [];

  // Helper: required scalar fields (title, brand, gtin) using comparePrimary
  function addRequiredScalar(
    field: string,
    legacyVal: unknown,
    newVal: unknown
  ): void {
    const cmp = comparePrimary(field, legacyVal, newVal);
    let status: FieldStatus;
    if (cmp.equal) {
      // Both absent or both match
      const legacyN = normalizeForCompare(legacyVal);
      const newN = normalizeForCompare(newVal);
      if (legacyN === null && newN !== null) {
        status = "new-only";
      } else {
        status = "match";
      }
    } else {
      // Not equal: check which side is missing
      status = classifyField(legacyVal, newVal);
    }
    perField.push({ field, legacyValue: legacyVal, newValue: newVal, status });
  }

  addRequiredScalar("title", legacySku.title, extractWinningValue(winningValues, "title"));
  addRequiredScalar("brand", legacySku.brand, extractWinningValue(winningValues, "brand"));
  addRequiredScalar("gtin", legacySku.gtin, extractWinningValue(winningValues, "gtin"));

  // primary_pricing: use comparePricing result to determine status
  {
    const pricingCmp = comparePricing(legacySku.pricing, pricingRows);
    const legacyAmount = legacySku.pricing.sale_price ?? legacySku.pricing.list_price;
    let status: FieldStatus;
    if (pricingCmp.equal) {
      if (legacyAmount === null) {
        status = "match"; // both absent
      } else {
        status = "match";
      }
    } else {
      if (pricingRows.length === 0) {
        status = "legacy-only";
      } else {
        status = "diff";
      }
    }
    perField.push({
      field: "primary_pricing",
      legacyValue: legacySku.pricing,
      newValue: pricingRows.length > 0 ? pricingRows : null,
      status
    });
  }

  // description (best-effort)
  {
    const legacyDesc = legacySku.description_long ?? legacySku.description_short ?? null;
    const newDesc = extractWinningValue(winningValues, "description");
    perField.push({
      field: "description",
      legacyValue: legacyDesc,
      newValue: newDesc,
      status: classifyField(legacyDesc, newDesc)
    });
  }

  // weight (best-effort)
  {
    const legacyWeight = legacySku.shipping?.weight ?? null;
    const newWeight = extractWinningValue(winningValues, "weight_grams");
    // Normalize: legacy weight is { value, unit }, new is a number (grams)
    const legacyWeightN =
      legacyWeight !== null && typeof legacyWeight === "object"
        ? (legacyWeight as { value: number; unit: string }).value
        : null;
    perField.push({
      field: "weight",
      legacyValue: legacyWeightN,
      newValue: newWeight,
      status: classifyField(legacyWeightN, newWeight)
    });
  }

  // images (best-effort — compare URL sets)
  {
    const legacyImageUrls = legacySku.images.map((img) => img.url).sort();
    const newImageObs = extractWinningValue(winningValues, "images");
    // images are deferred in v1 backfill — new is expected to be absent
    const legacyHasImages = legacyImageUrls.length > 0;
    const newHasImages =
      newImageObs !== null &&
      Array.isArray(newImageObs) &&
      (newImageObs as unknown[]).length > 0;
    let imgStatus: FieldStatus;
    if (!legacyHasImages && !newHasImages) {
      imgStatus = "match";
    } else if (legacyHasImages && !newHasImages) {
      // Expected for v1 — images deferred. Still report for human review.
      imgStatus = "legacy-only";
    } else if (!legacyHasImages && newHasImages) {
      imgStatus = "new-only";
    } else {
      imgStatus = "diff"; // both have images — leave for human review
    }
    perField.push({
      field: "images",
      legacyValue: legacyImageUrls.length > 0 ? `${legacyImageUrls.length} image(s)` : null,
      newValue: newHasImages ? `${(newImageObs as unknown[]).length} image(s)` : null,
      status: imgStatus
    });
  }

  // category (best-effort)
  {
    const legacyCategory = legacySku.category_path;
    const newCategory = extractWinningValue(winningValues, "category");
    perField.push({
      field: "category",
      legacyValue: legacyCategory,
      newValue: newCategory,
      status: classifyField(legacyCategory, newCategory)
    });
  }

  // Sort: losses first, then diffs, then new-only, then matches
  perField.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);

  // Determine worst status for this product (restricted to required fields for classification)
  const requiredFields = new Set(["title", "brand", "gtin", "primary_pricing"]);
  let worstStatus: "match" | "diff" | "loss" = "match";
  for (const f of perField) {
    if (!requiredFields.has(f.field)) continue;
    const cls = statusToProductClass(f.status);
    if (cls === "loss") {
      worstStatus = "loss";
      break;
    }
    if (cls === "diff" && worstStatus !== "loss") {
      worstStatus = "diff";
    }
  }

  return {
    productId,
    merchantId: product.merchantId,
    legacySku,
    newTrace,
    perField,
    worstStatus
  };
}

// ---- HTML rendering --------------------------------------------------------

function renderFieldTable(perField: FieldComparison[]): string {
  const rows = perField.map((f) => {
    const rowClass =
      f.status === "legacy-only" ? "loss" : f.status === "diff" ? "diff" : "match";
    const statusLabel =
      f.status === "legacy-only"
        ? "legacy-only"
        : f.status === "new-only"
        ? "new-only"
        : f.status;
    return `
      <tr class="${escapeHtml(rowClass)}">
        <td><code>${escapeHtml(f.field)}</code></td>
        <td><pre>${renderValue(f.legacyValue)}</pre></td>
        <td><pre>${renderValue(f.newValue)}</pre></td>
        <td>${escapeHtml(statusLabel)}</td>
      </tr>`;
  });

  return `<table class="field-table">
    <thead>
      <tr>
        <th>Field</th>
        <th>Legacy (SkuJson)</th>
        <th>New (winning_values)</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join("")}
    </tbody>
  </table>`;
}

function renderProductCard(result: ProductSpotCheckResult): string {
  const cardClass =
    result.worstStatus === "loss"
      ? "product has-loss"
      : result.worstStatus === "diff"
      ? "product has-diff"
      : "product";

  const legacyTitle = result.legacySku.title ?? "(no title)";
  const newTitle = result.newTrace
    ? (extractWinningValue(
        (result.newTrace.product.winningValues as Record<string, unknown>) ?? {},
        "title"
      ) as string | null) ?? "(no title)"
    : "(trace unavailable)";

  return `<div class="${escapeHtml(cardClass)}" id="product-${escapeHtml(result.productId)}">
  <div class="product-header">
    <code>${escapeHtml(result.productId)}</code>
    &nbsp;|&nbsp;
    <span class="legacy-title">${escapeHtml(truncate(legacyTitle, 80))}</span>
    &nbsp;→&nbsp;
    <span class="new-title">${escapeHtml(truncate(newTitle, 80))}</span>
  </div>
  ${renderFieldTable(result.perField)}
</div>`;
}

function renderSection(
  id: string,
  title: string,
  count: number,
  products: ProductSpotCheckResult[]
): string {
  if (products.length === 0) {
    return `<h2 id="${escapeHtml(id)}">${escapeHtml(title)} (${count})</h2>
<p><em>None.</em></p>`;
  }
  return `<h2 id="${escapeHtml(id)}">${escapeHtml(title)} (${count})</h2>
${products.map(renderProductCard).join("\n")}`;
}

function renderHtml(report: SpotCheckReport): string {
  const losses = report.products.filter((p) => p.worstStatus === "loss");
  const diffs = report.products.filter((p) => p.worstStatus === "diff");
  const matches = report.products.filter((p) => p.worstStatus === "match");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Catalog Spot-Check Report — Tenant ${escapeHtml(report.tenantId)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; color: #333; }
    h1 { margin-bottom: 10px; }
    h2 { margin-top: 30px; border-bottom: 1px solid #ccc; padding-bottom: 5px; }
    .summary { background: #f5f5f5; padding: 12px 16px; margin-bottom: 20px; border-radius: 4px; }
    .summary p { margin: 4px 0; }
    .product { border: 1px solid #ccc; margin-bottom: 15px; padding: 10px 12px; border-radius: 4px; }
    .product.has-diff { border-left: 4px solid #ffa500; }
    .product.has-loss { border-left: 4px solid #d32f2f; }
    .product-header { font-weight: bold; margin-bottom: 8px; font-size: 13px; word-break: break-all; }
    .legacy-title { color: #666; }
    .new-title { color: #2c6e49; }
    .field-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
    .field-table th { text-align: left; padding: 5px 8px; background: #f5f5f5; border-bottom: 1px solid #ddd; }
    .field-table td { padding: 5px 8px; vertical-align: top; border-bottom: 1px solid #eee; }
    .field-table tr.match td { background: #f0fff0; }
    .field-table tr.diff td { background: #fff8e1; }
    .field-table tr.loss td { background: #ffeaea; }
    pre { white-space: pre-wrap; word-break: break-word; max-width: 400px; font-size: 11px; margin: 0; }
    code { font-size: 12px; background: #f0f0f0; padding: 1px 3px; border-radius: 2px; }
    .pin-toc { position: sticky; top: 0; background: white; padding: 8px 12px; border-bottom: 1px solid #ccc; font-size: 13px; z-index: 100; }
    .pin-toc a { margin-right: 12px; color: #0066cc; text-decoration: none; }
    .pin-toc a:hover { text-decoration: underline; }
    em { color: #888; font-style: italic; }
  </style>
</head>
<body>
<h1>Catalog Spot-Check Report</h1>
<div class="summary">
  <p>Tenant: <code>${escapeHtml(report.tenantId)}</code></p>
  <p>Generated: ${escapeHtml(report.generatedAt)}</p>
  <p>Sample size: ${String(report.sampleSize)} (sampled: ${String(report.totalSampled)})</p>
  <p>Seed: ${String(report.seed)}</p>
  <p>All-match: ${String(report.allMatch)} &nbsp;&middot;&nbsp; Differences: ${String(report.withDiffs)} &nbsp;&middot;&nbsp; Possible losses: ${String(report.withLosses)}</p>
</div>
<div class="pin-toc">
  <a href="#with-losses">Losses (${String(losses.length)})</a>
  <a href="#with-diffs">Diffs (${String(diffs.length)})</a>
  <a href="#all-match">Match (${String(matches.length)})</a>
</div>

${renderSection("with-losses", "Possible losses", losses.length, losses)}

${renderSection("with-diffs", "Differences", diffs.length, diffs)}

${renderSection("all-match", "All-match", matches.length, matches)}
</body>
</html>`;
}

// ---- runSpotCheck (exported for tests) -------------------------------------

/**
 * Run the spot-check for a single tenant. Samples backfilled products,
 * compares legacy SkuJson against the new schema view, and returns a
 * {@link SpotCheckReport} with per-product field comparisons.
 *
 * The caller is responsible for writing the HTML output. The CLI main()
 * function writes it atomically (tmp + rename). Tests inspect the report
 * directly or pass a path via `options.outputPath`.
 *
 * @param deps  - `{ db }` — Drizzle client.
 * @param options - `tenantId`, `sampleSize`, `outputPath`, `seed`, optional `_timestampOverride`.
 * @returns       The full {@link SpotCheckReport}.
 */
export async function runSpotCheck(
  deps: SpotCheckDeps,
  options: SpotCheckOptions
): Promise<SpotCheckReport> {
  const { db } = deps;
  const {
    tenantId,
    sampleSize = 100,
    outputPath = "./spot-check-report.html",
    seed = Date.now(),
    _timestampOverride
  } = options;

  const clampedSize = Math.min(Math.max(1, sampleSize), 1000);

  const log = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[spot-check] ${msg}`);
  };
  const warn = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.error(`[spot-check] WARN: ${msg}`);
  };

  log(
    `Starting spot-check: tenant=${tenantId} sampleSize=${clampedSize} seed=${seed} output=${outputPath}`
  );

  // ---- 1. Sample backfilled products via Postgres random() ------------------
  // setseed() normalises the integer seed to [-1, 1] by dividing by 2^31.
  // Use the seed so the same value produces the same sample for a given data
  // snapshot, while different seeds (or the default Date.now()) produce
  // independent samples.
  const seedNorm = seed / 2147483648.0;

  // Set the Postgres random seed for deterministic sampling, then sample.
  // setseed() returns void so we call it in a separate statement before the
  // SELECT. For the non-deterministic case (default Date.now() seed) the
  // setseed call still runs but with a time-based value, which is fine.
  await db.execute(
    sql`SELECT setseed(${seedNorm}::float8)`
  );

  const sampledRows = await db.execute<{
    product_id: string;
  }>(
    sql`
      SELECT cp.product_id
      FROM catalog_products cp
      WHERE cp.tenant_id = ${tenantId}
        AND EXISTS (
          SELECT 1
          FROM catalog_product_revisions cpr
          WHERE cpr.product_id = cp.product_id
            AND cpr.revision_reason = 'migration_backfill'
        )
      ORDER BY random(), cp.product_id
      LIMIT ${clampedSize}
    `
  );

  const productIds = sampledRows.rows.map((r) => r.product_id);

  log(`Sampled ${productIds.length} backfilled products (of up to ${clampedSize} requested)`);

  // ---- 2. Spot-check each product ------------------------------------------
  const results: ProductSpotCheckResult[] = [];

  for (const productId of productIds) {
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

    try {
      const result = await spotCheckProduct(db, product);
      results.push(result);
    } catch (err) {
      warn(
        `Error processing product ${productId}: ${err instanceof Error ? err.message : String(err)}`
      );
      // Skip individual errors — report as much as possible
    }
  }

  // ---- 3. Build report -------------------------------------------------------
  const allMatch = results.filter((r) => r.worstStatus === "match").length;
  const withDiffs = results.filter((r) => r.worstStatus === "diff").length;
  const withLosses = results.filter((r) => r.worstStatus === "loss").length;

  const generatedAt = _timestampOverride ?? new Date().toISOString();

  const report: SpotCheckReport = {
    tenantId,
    sampleSize: clampedSize,
    seed,
    generatedAt,
    totalSampled: results.length,
    allMatch,
    withDiffs,
    withLosses,
    products: results
  };

  log(
    `Spot-check complete: sampled=${results.length} match=${allMatch} diffs=${withDiffs} losses=${withLosses}`
  );

  // ---- 4. Render and write HTML atomically ----------------------------------
  const html = renderHtml(report);
  const tmpPath = `${outputPath}.tmp`;
  await writeFile(tmpPath, html, "utf-8");
  await rename(tmpPath, outputPath);
  log(`Report written to ${outputPath}`);

  return report;
}

// ---- CLI entrypoint --------------------------------------------------------

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[spot-check] ${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // eslint-disable-next-line no-console
    console.error("[spot-check] DATABASE_URL is required");
    process.exit(1);
  }

  const { client, close } = createDb(databaseUrl);
  try {
    await runSpotCheck(
      { db: client },
      {
        tenantId: args.tenantId,
        sampleSize: args.sampleSize,
        outputPath: args.outputPath,
        seed: args.seed
      }
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[spot-check] Failed:", err);
    process.exit(2);
  } finally {
    await close();
  }
}

// Only run as CLI entrypoint — not when imported by tests.
if (import.meta.main) {
  await main();
}
