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
// Run: bun --env-file=../../.env run scripts/backfill-catalog.ts \
//        --tenant-id <uuid> [options]
//
// Catalog redesign Phase 7 — Task 7.1 — Backfill script.
//
// Migrates legacy product_versions + extracted_facts into the new
// catalog_products schema. Idempotent (observation dedup) and resumable
// (backfill_cursor table tracks progress per tenant).
//
// FK chain navigated to reach extracted_facts:
//   product_versions.proposed_diff_id
//     → proposed_diffs.source_fact_set_id
//     → extracted_fact_sets.id
//     → extracted_facts.fact_set_id
//
// Design decisions:
//  - reasonOverride: Option A — extended writeAdapterOutput with optional
//    `reasonOverride` parameter so backfill revisions are tagged
//    'migration_backfill' without a separate INSERT.
//  - sourceOverride: Option A — extended writeAdapterOutput with optional
//    `sourceOverride` parameter so revision.source_kind is written as
//    "legacy:product_versions" (plan §7.1 step 5 literal) rather than
//    deriving "backfill" from the actor prefix "backfill:product_versions".
//  - rawPayload: per plan §7.1 step 5, revision.raw_payload references the
//    source_artifact's raw_data. The backfill navigates the FK chain
//    (proposedDiffId → sourceFactSetId → linkIngestionTraceSets.artifactId →
//    source_artifacts.rawData) and wraps it with provenance metadata
//    (source_artifact_id, product_version_id, proposed_diff_id, etc.).
//  - Inventory observations: skipped for v1 — legacy product_versions did
//    not track per-version inventory quantities.
//  - Variants: skipped for v1 — backfill targets parent metadata only.
//    product_variant_versions are not migrated in this phase.
//  - Images: deferred. The images[] column exists on product_versions but
//    the canonical attribute code for image arrays is not yet defined in
//    attribute_definitions for the new schema. Backfill logs image count
//    and skips writing them to avoid polluting values JSONB with unkeyed blobs.
//  - Pricing channel resolution: requires a channels row for (tenant_id,
//    merchant_id). If none exists, pricing is skipped for that version with
//    a warning log. No channel creation occurs.
//
// Spec deviations:
//  - SPEC DEVIATION (plan §7.1 step 5): plan specifies confidence=0.7 on
//    the revision row, but catalog_product_revisions has no confidence
//    column. Confidence is applied to per-observation entries inside the
//    values JSONB (each observation carries its own confidence field).
//    The backfill uses confidence=0.7 as the default for observations from
//    typed product_version columns (title=0.8, gtin=0.9, others=0.7).
//    Per-observation confidence is what landed — no schema change in this task.
//  - SPEC DEVIATION v1 limitation: catalog_pricing_observations does not have
//    a unique constraint on (source, source_record_id). As a result, idempotent
//    re-runs (via --from-scratch) DOUBLE pricing rows in that side table.
//    Canonical observations in catalog_products.values are correctly deduped
//    (writeAdapterOutput uses ON CONFLICT DO UPDATE for those). Pricing dedup
//    (ON CONFLICT) is deferred to a future migration that adds the constraint.
//    Operators should avoid --from-scratch on tenants with live pricing data
//    until that migration lands.
//
// Exit codes:
//   0  Success (or dry-run completed)
//   1  Bad input or already-complete cursor (without --from-scratch)
//   2  Runtime error (DB connection, unrecoverable failure)

import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createDb, schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId, ChannelId } from "@aonex/types";
import type { AdapterOutput, CanonicalObservation, PricingObservation } from "@aonex/catalog-source-adapters";
import { writeAdapterOutput } from "@aonex/catalog-service";

// ---- Types -----------------------------------------------------------------

export interface BackfillDeps {
  db: DrizzleClient;
}

export interface BackfillOptions {
  tenantId: string;
  batchSize?: number;
  dryRun?: boolean;
  fromScratch?: boolean;
  limit?: number;
}

export interface BackfillResult {
  tenantId: string;
  totalProcessed: number;
  totalSkipped: number;
  totalFailed: number;
  completed: boolean;
  dryRun: boolean;
}

interface ParsedArgs {
  tenantId: string;
  batchSize: number;
  dryRun: boolean;
  fromScratch: boolean;
  limit: number | undefined;
}

// ---- Help / usage ----------------------------------------------------------

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: bun --env-file=../../.env run scripts/backfill-catalog.ts --tenant-id <uuid> [options]

Backfill the new catalog_products schema from legacy product_versions + extracted_facts.
Idempotent (re-running for the same product_version_id is a no-op via observation dedup).
Resumable (cursor table backfill_cursor tracks progress per tenant).

Required:
  --tenant-id <uuid>      Tenant scope.

Options:
  --batch-size <n>        Rows per batch. Default 100.
  --dry-run               Report what would be written without writing. Cursor not updated.
  --from-scratch          Ignore existing cursor; restart from the beginning.
  --limit <n>             Stop after N product_versions processed (for testing).
  --help, -h              Print this and exit.

Exit codes:
  0  Success (or dry-run completed)
  1  Bad input or completed cursor
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
 * Consume `--flag value` or `--flag=value` from argv at position i.
 */
function take(
  argv: string[],
  name: string,
  i: number
): { value: string; consumed: number } {
  const arg = argv[i]!;
  const eq = arg.indexOf("=");
  if (eq >= 0) {
    const value = arg.slice(eq + 1);
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
  let batchSize = 100;
  let dryRun = false;
  let fromScratch = false;
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--from-scratch") {
      fromScratch = true;
    } else if (arg === "--tenant-id" || arg.startsWith("--tenant-id=")) {
      const { value, consumed } = take(argv, "--tenant-id", i);
      tenantId = value;
      i += consumed - 1;
    } else if (arg === "--batch-size" || arg.startsWith("--batch-size=")) {
      const { value, consumed } = take(argv, "--batch-size", i);
      batchSize = parsePositiveInt("--batch-size", value);
      i += consumed - 1;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const { value, consumed } = take(argv, "--limit", i);
      limit = parsePositiveInt("--limit", value);
      i += consumed - 1;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!tenantId) throw new Error("--tenant-id is required");
  if (!looksLikeUuid(tenantId)) {
    throw new Error(`--tenant-id must be a UUID; got: ${tenantId}`);
  }

  return { tenantId, batchSize, dryRun, fromScratch, limit };
}

// ---- Core backfill logic ---------------------------------------------------

/**
 * Resolve the first channel attached to (tenantId, merchantId) from the
 * channels table. Returns { channelId, channelCode } or null if not found.
 *
 * The channel code is synthesised as "<channelKind>-<region>" matching the
 * convention used by the Shopify adapter (`shopify-au`). If region is null
 * we fall back to channelKind alone.
 */
async function resolveChannelForMerchant(
  db: DrizzleClient,
  tenantId: string,
  merchantId: string
): Promise<{ channelId: ChannelId; channelCode: string } | null> {
  // channels table has tenantId but NOT merchantId — it's a tenant-level
  // registry. We pick the first channel for the tenant and use it for all
  // merchant versions. A v2 backfill would join through a merchant↔channel
  // mapping table if one exists.
  const rows = await db
    .select({
      channelId: schema.channels.channelId,
      channelKind: schema.channels.channelKind,
      region: schema.channels.region
    })
    .from(schema.channels)
    .where(eq(schema.channels.tenantId, tenantId))
    .orderBy(schema.channels.channelId)
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const channelCode = row.region
    ? `${row.channelKind}-${row.region}`
    : row.channelKind;

  return { channelId: row.channelId as ChannelId, channelCode };
}

interface ExtractedContext {
  facts: typeof schema.linkIngestionTraceFacts.$inferSelect[];
  /** raw_data from the source_artifact linked via the fact_set's artifact_id. */
  sourceArtifactRawData: Record<string, unknown> | null;
  /** The source_artifact UUID (for rawPayload provenance). */
  sourceArtifactId: string | null;
}

/**
 * Fetch extracted_facts and the parent source_artifact's raw_data for a
 * product_version by navigating the FK chain:
 *   product_versions.proposed_diff_id
 *     → proposed_diffs.source_fact_set_id
 *     → extracted_fact_sets.artifact_id
 *     → source_artifacts.raw_data
 *
 * Returns empty facts and null artifact data if any link in the chain is absent.
 */
async function fetchExtractedContext(
  db: DrizzleClient,
  productVersion: typeof schema.productVersions.$inferSelect
): Promise<ExtractedContext> {
  // Step 1: look up proposed_diff to get source_fact_set_id
  const diffRows = await db
    .select({ sourceFactSetId: schema.proposedDiffs.sourceFactSetId })
    .from(schema.proposedDiffs)
    .where(eq(schema.proposedDiffs.id, productVersion.proposedDiffId))
    .limit(1);

  const factSetId = diffRows[0]?.sourceFactSetId;
  if (!factSetId) return { facts: [], sourceArtifactRawData: null, sourceArtifactId: null };

  // Step 2: fetch fact_set to get artifact_id, and fetch extracted_facts in parallel
  const [factSetRows, facts] = await Promise.all([
    db
      .select({ artifactId: schema.linkIngestionTraceSets.artifactId })
      .from(schema.linkIngestionTraceSets)
      .where(eq(schema.linkIngestionTraceSets.id, factSetId))
      .limit(1),
    db
      .select()
      .from(schema.linkIngestionTraceFacts)
      .where(eq(schema.linkIngestionTraceFacts.factSetId, factSetId))
  ]);

  const artifactId = factSetRows[0]?.artifactId ?? null;
  if (!artifactId) return { facts, sourceArtifactRawData: null, sourceArtifactId: null };

  // Step 3: fetch source_artifact.raw_data
  const artifactRows = await db
    .select({ rawData: schema.sourceArtifacts.rawData })
    .from(schema.sourceArtifacts)
    .where(eq(schema.sourceArtifacts.id, artifactId))
    .limit(1);

  const sourceArtifactRawData = artifactRows[0]?.rawData ?? null;
  return { facts, sourceArtifactRawData, sourceArtifactId: artifactId };
}

/**
 * Build an AdapterOutput from a legacy product_version row + associated
 * extracted_facts (optional enrichment) and the parent source_artifact.
 *
 * v1 scope:
 *  - IdentityHint: from gtin, brand+modelNumber, or mpn+brand
 *  - CanonicalObservations: title, brand, model_number, mpn, gtin,
 *    description, weight, dimensions, category
 *    (images deferred — canonical attribute code not yet defined)
 *  - PricingObservation: from basePrice+currency if channel resolves
 *  - InventoryObservation: none (legacy had no per-version inventory)
 *  - Variants: none (backfill targets parent metadata only)
 */
function buildAdapterOutput(
  pv: typeof schema.productVersions.$inferSelect,
  channel: { channelId: ChannelId; channelCode: string } | null,
  _facts: typeof schema.linkIngestionTraceFacts.$inferSelect[],
  // facts are included for forward compatibility; v1 derives observations
  // from typed product_version columns, not from raw facts. The facts
  // parameter is intentionally unused in this version — a v2 backfill can
  // enrich from canonicalPath-mapped facts for the attribute observations.
  sourceArtifactRawData: Record<string, unknown> | null = null,
  sourceArtifactId: string | null = null
): AdapterOutput {
  const SOURCE = "legacy:product_versions";
  const SOURCE_RECORD_ID = pv.id;
  const OBSERVED_AT = pv.createdAt;
  const CHANNEL_CODE = channel?.channelCode ?? "_unscoped";
  const LOCALE_CODE = "_unscoped";

  // ---- 1. IdentityHint ------------------------------------------------
  let identityHint: AdapterOutput["identityHint"];
  if (pv.gtin) {
    identityHint = {
      gtin: pv.gtin,
      targetIsVariant: false,
      ...(pv.brand ? { brand: pv.brand } : {}),
      titleForFuzzy: pv.title
    };
  } else if (pv.brand && pv.modelNumber) {
    identityHint = {
      brand: pv.brand,
      model_number: pv.modelNumber,
      targetIsVariant: false,
      titleForFuzzy: pv.title
    };
  } else if (pv.manufacturerPartNumber && pv.brand) {
    identityHint = {
      mpn: pv.manufacturerPartNumber,
      brand: pv.brand,
      targetIsVariant: false,
      titleForFuzzy: pv.title
    };
  } else {
    identityHint = {
      targetIsVariant: false,
      titleForFuzzy: pv.title
    };
  }

  // ---- 2. CanonicalObservations from typed columns --------------------
  const observations: CanonicalObservation[] = [];

  function obs(
    attributeCode: string,
    value: unknown,
    confidence = 0.7
  ): void {
    if (value === null || value === undefined) return;
    if (typeof value === "string" && value.trim().length === 0) return;
    observations.push({
      attributeCode,
      target: "parent",
      channelCode: CHANNEL_CODE,
      localeCode: LOCALE_CODE,
      source: SOURCE,
      sourceRecordId: SOURCE_RECORD_ID,
      value,
      confidence,
      observedAt: OBSERVED_AT
    });
  }

  obs("title", pv.title, 0.8);
  obs("brand", pv.brand);
  obs("model_number", pv.modelNumber);
  obs("mpn", pv.manufacturerPartNumber);
  obs("gtin", pv.gtin, 0.9);
  obs("description", pv.description);

  // Weight: stored as grams (numeric string from db); emit as number
  if (pv.weightGrams !== null && pv.weightGrams !== undefined) {
    const w = Number(pv.weightGrams);
    if (Number.isFinite(w) && w > 0) {
      obs("weight_grams", w);
    }
  }

  // Dimensions: stored as { l, w, h } object
  if (pv.dimensionsCm && typeof pv.dimensionsCm === "object") {
    obs("dimensions_cm", pv.dimensionsCm);
  }

  // Category
  obs("category", pv.canonicalCategory);

  // Images: deferred — canonical attribute code not yet defined in
  // attribute_definitions. Emit a count log in the caller if images exist.
  // Do NOT write images to values JSONB to avoid unkeyed blob pollution.

  // Attributes JSON: emit each key as a separate observation so the
  // reconciler can project them individually. Confidence matches overall
  // product version confidence.
  const pvConf = pv.confidenceScore !== null ? Number(pv.confidenceScore) : 0.7;
  if (pv.attributesJson && typeof pv.attributesJson === "object") {
    for (const [key, val] of Object.entries(pv.attributesJson)) {
      if (val === null || val === undefined) continue;
      obs(`attr.${key}`, val, pvConf);
    }
  }

  // ---- 3. PricingObservation ------------------------------------------
  const pricingObservations: PricingObservation[] = [];

  if (pv.basePrice && pv.currency && channel) {
    const amount = Number(pv.basePrice);
    if (Number.isFinite(amount) && amount > 0) {
      pricingObservations.push({
        productHint: pv.productId,
        channelCode: channel.channelCode,
        locale: LOCALE_CODE,
        source: SOURCE,
        sourceRecordId: SOURCE_RECORD_ID,
        currency: pv.currency,
        tiers: [{ kind: "base", amount }],
        observedAt: OBSERVED_AT
      });
    }
  }

  // ---- 4. rawPayload --------------------------------------------------
  // Per plan §7.1 step 5: raw_payload points at the source_artifact's
  // raw_data. The wrapper preserves auxiliary provenance (product_version_id,
  // proposed_diff_id, etc.) so revisions are fully auditable even without
  // joining back through the FK chain.
  const rawPayload: Record<string, unknown> = {
    source: SOURCE,
    source_artifact_id: sourceArtifactId,
    product_version_id: pv.id,
    product_id: pv.productId,
    tenant_id: pv.tenantId,
    merchant_id: pv.merchantId,
    proposed_diff_id: pv.proposedDiffId,
    schema_version: pv.schemaVersion,
    confidence_score: pv.confidenceScore,
    created_at: pv.createdAt.toISOString(),
    // The raw_data blob from source_artifacts — the primary provenance target
    // per plan §7.1 step 5. Null when the artifact could not be resolved
    // through the FK chain (e.g., legacy rows with no source_artifact).
    raw_data: sourceArtifactRawData
  };

  return {
    observations,
    pricingObservations,
    inventoryObservations: [],
    identityHint,
    rawPayload
  };
}

// ---- runBackfill (exported for tests) -------------------------------------

/**
 * Backfill the new catalog schema from legacy `product_versions` +
 * `extracted_facts` rows for a single tenant.
 *
 * **Idempotency**: re-running for the same `product_version` is a no-op.
 * Canonical observations are deduped inside `writeAdapterOutput` using
 * `(source, source_record_id, attribute_code)` uniqueness — re-running
 * produces no new observation rows. Pricing observations are NOT deduped
 * (no unique constraint on the side table in v1); see the spec-deviations
 * header for details.
 *
 * **Resumability**: progress is persisted in the `backfill_cursor` table
 * (one row per tenant). Each batch advances the cursor to the highest
 * successfully-processed `product_version` UUID. On restart, the query
 * resumes from `WHERE pv.id > lastProductVersionIdProcessed`.
 *
 * **`dryRun` semantics**: observations and catalog rows are NOT written.
 * The cursor is NOT updated. Logs describe what _would_ be written.
 *
 * **`fromScratch` semantics**: the cursor row's counters, `lastId`, and
 * `startedAt` are reset (via UPDATE SET) before processing begins. The row
 * itself is retained (UPSERT on initial insert). Implies a full re-scan.
 *
 * **`completed: false` in result**: the limit was hit before all
 * `product_versions` were exhausted; the run did NOT reach EOF.
 *
 * @returns {@link BackfillResult} — summary counters and completion flag.
 */
export async function runBackfill(
  deps: BackfillDeps,
  options: BackfillOptions
): Promise<BackfillResult> {
  const { db } = deps;
  const {
    tenantId,
    batchSize = 100,
    dryRun = false,
    fromScratch = false,
    limit
  } = options;

  const log = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[backfill-catalog] ${msg}`);
  };
  const warn = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.error(`[backfill-catalog] WARN: ${msg}`);
  };

  // ---- 1. Read / initialise cursor ------------------------------------
  let cursorRow = await db
    .select()
    .from(schema.backfillCursor)
    .where(eq(schema.backfillCursor.tenantId, tenantId))
    .limit(1)
    .then((r) => r[0] ?? null);

  if (cursorRow?.completedAt && !fromScratch) {
    log(`Backfill already complete for tenant ${tenantId} (completed_at=${cursorRow.completedAt.toISOString()}). Pass --from-scratch to restart.`);
    return {
      tenantId,
      totalProcessed: cursorRow.totalProcessed,
      totalSkipped: cursorRow.totalSkipped,
      totalFailed: cursorRow.totalFailed,
      completed: true,
      dryRun
    };
  }

  // Initialise or reset cursor (only when not dry-run)
  let lastId: string | null = fromScratch ? null : (cursorRow?.lastProductVersionIdProcessed ?? null);
  let totalProcessed = fromScratch ? 0 : (cursorRow?.totalProcessed ?? 0);
  let totalSkipped = fromScratch ? 0 : (cursorRow?.totalSkipped ?? 0);
  let totalFailed = fromScratch ? 0 : (cursorRow?.totalFailed ?? 0);

  if (!dryRun) {
    if (!cursorRow) {
      await db.insert(schema.backfillCursor).values({ tenantId });
      cursorRow = await db
        .select()
        .from(schema.backfillCursor)
        .where(eq(schema.backfillCursor.tenantId, tenantId))
        .limit(1)
        .then((r) => r[0] ?? null);
    } else if (fromScratch) {
      await db
        .update(schema.backfillCursor)
        .set({
          lastProductVersionIdProcessed: null,
          completedAt: null,
          totalProcessed: 0,
          totalSkipped: 0,
          totalFailed: 0,
          startedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(schema.backfillCursor.tenantId, tenantId));
    }
  }

  log(`Starting backfill for tenant=${tenantId} lastId=${lastId ?? "none"} batchSize=${batchSize} dryRun=${dryRun}`);

  let limitRemaining = limit;
  let batchCompleted = false;

  // ---- 2. Main batch loop --------------------------------------------
  // Accumulate all failed IDs across the entire run for the final summary.
  const allFailedIds: string[] = [];

  // channelCache: persisted across batches so the same merchantId is only
  // looked up once per run (avoids redundant DB round-trips).
  const channelCache = new Map<
    string,
    { channelId: ChannelId; channelCode: string } | null
  >();

  while (true) {
    const effectiveBatch =
      limitRemaining !== undefined
        ? Math.min(batchSize, limitRemaining)
        : batchSize;

    // Query: current versions only (join with products.current_version_id)
    const whereClause =
      lastId !== null
        ? and(
            eq(schema.productVersions.tenantId, tenantId),
            gt(schema.productVersions.id, lastId)
          )
        : eq(schema.productVersions.tenantId, tenantId);

    const batch = await db
      .select({
        pv: schema.productVersions
      })
      .from(schema.productVersions)
      .innerJoin(
        schema.products,
        and(
          eq(schema.products.currentVersionId, schema.productVersions.id),
          eq(schema.products.tenantId, tenantId)
        )
      )
      .where(whereClause)
      .orderBy(schema.productVersions.id)
      .limit(effectiveBatch);

    if (batch.length === 0) {
      batchCompleted = true;
      break;
    }

    // Per-batch tracking for safe cursor advancement.
    // maxSuccessId: highest UUID that succeeded in this batch (cursor advances here).
    // failedIds: IDs that failed — kept below cursor for operator retry.
    let maxSuccessId: string | null = null;
    const failedIdsThisBatch: string[] = [];

    for (const { pv } of batch) {
      const merchantId = pv.merchantId;

      // Resolve channel (once per merchantId across all batches)
      if (!channelCache.has(merchantId)) {
        const ch = await resolveChannelForMerchant(db, tenantId, merchantId);
        channelCache.set(merchantId, ch);
        if (!ch) {
          warn(`No channel found for tenantId=${tenantId} merchantId=${merchantId}; pricing will be skipped for their product_versions`);
        }
      }
      const channel = channelCache.get(merchantId) ?? null;

      // Fetch extracted_facts and source_artifact.raw_data via FK chain
      const { facts, sourceArtifactRawData, sourceArtifactId } = await fetchExtractedContext(db, pv);

      // Build AdapterOutput
      const adapterOutput = buildAdapterOutput(pv, channel, facts, sourceArtifactRawData, sourceArtifactId);

      // Log deferred fields
      if (Array.isArray(pv.images) && pv.images.length > 0) {
        log(`  product_version ${pv.id}: has ${pv.images.length} image(s) — deferred (canonical attribute code not defined)`);
      }

      if (dryRun) {
        log(`  [DRY-RUN] would write product_version ${pv.id}: ${adapterOutput.observations.length} obs, ${adapterOutput.pricingObservations.length} pricing, identityHint=${JSON.stringify(adapterOutput.identityHint)}`);
        totalProcessed++;
        maxSuccessId = pv.id;
        continue;
      }

      // Write to catalog
      try {
        const result = await writeAdapterOutput({
          db,
          tenantId: tenantId as TenantId,
          merchantId: merchantId as MerchantId,
          adapterOutput,
          actor: "backfill:product_versions",
          reasonOverride: "migration_backfill",
          sourceOverride: "legacy:product_versions",
          ...(channel
            ? {
                channelCodeToId: {
                  [channel.channelCode]: channel.channelId
                }
              }
            : {})
        });

        if (result.created || result.observationsWritten > 0 || result.pricingObservationsWritten > 0) {
          totalProcessed++;
          log(`  product_version ${pv.id}: productId=${result.productId} created=${result.created} obs=${result.observationsWritten} pricing=${result.pricingObservationsWritten}`);
        } else {
          // Nothing new written — fully deduped (already processed)
          totalSkipped++;
          log(`  product_version ${pv.id}: skipped (fully deduped, productId=${result.productId})`);
        }
        // Only advance the success cursor on actual success.
        maxSuccessId = pv.id;
      } catch (err) {
        totalFailed++;
        failedIdsThisBatch.push(pv.id);
        warn(`product_version ${pv.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        // Do NOT advance maxSuccessId — failed rows stay below cursor for retry.
        // Continue — don't halt the whole backfill on a single error.
      }
    }

    // Accumulate failed IDs for the final run summary.
    allFailedIds.push(...failedIdsThisBatch);
    if (failedIdsThisBatch.length > 0) {
      warn(`batch failed IDs: ${JSON.stringify(failedIdsThisBatch)}`);
    }

    // Determine how far to advance the cursor.
    // - Common case: at least one row succeeded → advance to maxSuccessId.
    //   Failed rows below that point are logged above and available for retry.
    // - Pathological case: all rows in the batch failed → advance past them
    //   to prevent an infinite loop. Log loudly so operators can investigate.
    const batchMaxId = batch[batch.length - 1]!.pv.id;
    if (maxSuccessId !== null) {
      lastId = maxSuccessId;
    } else {
      // All rows failed — advance past the batch to avoid looping forever.
      warn(`all rows in batch failed, advancing cursor past them to avoid infinite loop; failed: ${JSON.stringify(failedIdsThisBatch)}`);
      lastId = batchMaxId;
    }

    // Update cursor after each batch (skip if dry-run)
    if (!dryRun && lastId !== null) {
      await db
        .update(schema.backfillCursor)
        .set({
          lastProductVersionIdProcessed: lastId,
          totalProcessed,
          totalSkipped,
          totalFailed,
          updatedAt: new Date()
        })
        .where(eq(schema.backfillCursor.tenantId, tenantId));
    }

    // Progress log every 100 rows (guard against spurious log at total=0)
    const total = totalProcessed + totalSkipped + totalFailed;
    if (total > 0 && total % 100 === 0) {
      log(`Progress: processed=${totalProcessed} skipped=${totalSkipped} failed=${totalFailed}`);
    }

    // Check limit
    if (limitRemaining !== undefined) {
      limitRemaining -= batch.length;
      if (limitRemaining <= 0) {
        log(`--limit reached; stopping without marking completed.`);
        break;
      }
    }

    // End of data
    if (batch.length < effectiveBatch) {
      batchCompleted = true;
      break;
    }
  }

  // ---- 3. Mark complete if we exhausted all data ----------------------
  if (batchCompleted && !dryRun) {
    await db
      .update(schema.backfillCursor)
      .set({
        completedAt: new Date(),
        totalProcessed,
        totalSkipped,
        totalFailed,
        updatedAt: new Date()
      })
      .where(eq(schema.backfillCursor.tenantId, tenantId));
    log(`Backfill complete for tenant=${tenantId}`);
  }

  // ---- 4. Final summary -----------------------------------------------
  log(
    `Summary: tenant=${tenantId} processed=${totalProcessed} skipped=${totalSkipped} failed=${totalFailed} completed=${batchCompleted} dryRun=${dryRun}`
  );
  if (allFailedIds.length > 0) {
    warn(`Run completed with ${allFailedIds.length} failed product_version(s). Retry these IDs manually: ${JSON.stringify(allFailedIds)}`);
  }

  return {
    tenantId,
    totalProcessed,
    totalSkipped,
    totalFailed,
    completed: batchCompleted,
    dryRun
  };
}

// ---- CLI entrypoint --------------------------------------------------------

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[backfill-catalog] ${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // eslint-disable-next-line no-console
    console.error("[backfill-catalog] DATABASE_URL is required");
    process.exit(1);
  }

  const { client, close } = createDb(databaseUrl);
  try {
    const result = await runBackfill(
      { db: client },
      {
        tenantId: args.tenantId,
        batchSize: args.batchSize,
        dryRun: args.dryRun,
        fromScratch: args.fromScratch,
        limit: args.limit
      }
    );

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));

    if (result.totalFailed > 0) {
      process.exit(2);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[backfill-catalog] Failed:", err);
    process.exit(2);
  } finally {
    await close();
  }
}

// Only run as CLI entrypoint — not when imported by tests.
if (import.meta.main) {
  await main();
}
