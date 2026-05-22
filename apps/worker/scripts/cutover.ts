#!/usr/bin/env bun
// HISTORICAL ARTIFACT — Phase 9.3 closed the catalog redesign.
// This script was executed ONCE during Phase 8.4 to rename legacy tables.
// It is retained for audit purposes only and SHOULD NOT be run again.
// The CATALOG_USE_NEW_SCHEMA and CATALOG_DUAL_WRITE env vars no longer exist.
//
// Run: bun --env-file=../../.env run scripts/cutover.ts \
//        --tenant-id <uuid> --confirm-drained [options]
//
// Catalog redesign Phase 8 — Task 8.1 — Cutover script.
//
// PHASE 8 — Catalog Cutover (rename legacy tables, switch to new schema only).
//
// PREREQUISITES (operator responsibility):
//   1. Phase 7 soak passed (validation 100% zero-loss, parity tests green for 7 days).
//   2. CATALOG_USE_NEW_SCHEMA=true in production (already set during Phase 7).
//   3. CATALOG_DUAL_WRITE=false (flipped + worker restarted BEFORE running cutover).
//   4. BullMQ in-flight jobs drained (no pending link-extract / drain jobs).
//   5. RDS snapshot taken (rollback insurance).
//
// Exit codes:
//   0  Cutover succeeded (or dry-run completed)
//   1  Pre-flight failed, validation failed, or bad input
//   2  Runtime error during rename (partial state possible — check DB!)

import { eq, and, isNotNull, sql } from "drizzle-orm";
import { createDb, schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import { writeFile, rename } from "node:fs/promises";
import { runValidation } from "./validate-backfill.js";

// ---- Pre-flight error -------------------------------------------------------

/**
 * Error codes for pre-flight failures.
 *
 * runCutover throws a CutoverPreflightError (rather than calling process.exit)
 * so tests can assert the specific guard that fired. The CLI main() catches it
 * and calls process.exit(1).
 */
export type CutoverPreflightCode =
  | "PREFLIGHT_USE_NEW_SCHEMA_OFF"
  | "PREFLIGHT_DUAL_WRITE_ON"
  | "PREFLIGHT_BACKFILL_INCOMPLETE"
  | "PREFLIGHT_NOT_DRAINED";

export class CutoverPreflightError extends Error {
  readonly code: CutoverPreflightCode;
  constructor(code: CutoverPreflightCode, message: string) {
    super(message);
    this.name = "CutoverPreflightError";
    this.code = code;
  }
}

// ---- Types -----------------------------------------------------------------

export interface CutoverDeps {
  db: DrizzleClient;
  /**
   * HISTORICAL: always true post Phase 9.3 (flag removed from env schema).
   * Retained for backward compatibility with tests only.
   */
  useNewCatalogSchema: boolean;
  /**
   * HISTORICAL: always false post Phase 9.3 (flag removed from env schema).
   * Retained for backward compatibility with tests only.
   */
  useDualWrite: boolean;
}

export interface CutoverOptions {
  tenantId: string;
  dryRun?: boolean;
  confirmDrained?: boolean;
  skipValidation?: boolean;
  force?: boolean;
  saveReport?: string;
  /**
   * Configurable table rename pairs. Defaults to the production list.
   * Tests inject test-prefixed pairs to avoid touching the real schema.
   */
  legacyTablePairs?: Array<{ from: string; to: string }>;
}

export interface CutoverReport {
  tenantId: string;
  cutoverAt: string;
  validated: boolean;
  dryRun: boolean;
  renamedTables: Array<{ from: string; to: string }>;
  alreadyRenamedTables: Array<{ from: string; to: string }>;
  validationSummary?: {
    totalScanned: number;
    totalPassed: number;
    totalFailed: number;
  };
}

// ---- Production table pairs ------------------------------------------------

export const PRODUCTION_TABLE_PAIRS: Array<{ from: string; to: string }> = [
  { from: "products",                    to: "_legacy_products" },
  { from: "product_versions",            to: "_legacy_product_versions" },
  { from: "product_identities",          to: "_legacy_product_identities" },
  { from: "product_variants",            to: "_legacy_product_variants" },
  { from: "product_variant_versions",    to: "_legacy_product_variant_versions" },
  { from: "proposed_diffs",              to: "_legacy_proposed_diffs" },
  { from: "proposed_diff_fields",        to: "_legacy_proposed_diff_fields" },
];

// ---- Helpers ---------------------------------------------------------------

const log = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(`[cutover] ${msg}`);
};

const warn = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.error(`[cutover] WARN: ${msg}`);
};

const err = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.error(`[cutover] ERROR: ${msg}`);
};

function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Check whether a table with the given name exists in the public schema.
 */
async function tableExists(db: DrizzleClient, tableName: string): Promise<boolean> {
  const rows = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
    ) AS exists
  `);
  return Boolean(rows.rows[0]?.exists);
}

// ---- Help text -------------------------------------------------------------

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: bun apps/worker/scripts/cutover.ts --tenant-id <uuid> [options]

PHASE 8 — Catalog Cutover (rename legacy tables, switch to new schema only).

PREREQUISITES (operator responsibility):
  1. Phase 7 soak passed (validation 100% zero-loss, parity tests green for 7 days).
  2. CATALOG_USE_NEW_SCHEMA=true in production (already set during Phase 7).
  3. CATALOG_DUAL_WRITE=false (flipped + worker restarted BEFORE running cutover).
  4. BullMQ in-flight jobs drained (no pending link-extract / drain jobs).
  5. RDS snapshot taken (rollback insurance).

Required:
  --tenant-id <uuid>      Tenant scope.

Options:
  --dry-run               Log what would happen without executing.
  --confirm-drained       Confirm in-flight BullMQ jobs are drained.
  --skip-validation       Skip the final validation check (DANGEROUS).
  --force                 Proceed on validation warnings (NOT on errors).
  --save-report <path>    Write JSON cutover report.
  --help, -h              Print this and exit.

Exit codes:
  0  Cutover succeeded
  1  Pre-flight failed, validation failed, or bad input
  2  Runtime error during rename (partial state possible — check DB!)`);
}

// ---- Arg parsing -----------------------------------------------------------

interface ParsedArgs {
  tenantId: string;
  dryRun: boolean;
  confirmDrained: boolean;
  skipValidation: boolean;
  force: boolean;
  saveReport: string | undefined;
}

function take(
  argv: string[],
  name: string,
  i: number
): { value: string; consumed: number } {
  const arg = argv[i]!;
  const eqIdx = arg.indexOf("=");
  if (eqIdx >= 0) {
    const value = arg.slice(eqIdx + 1);
    if (value.length === 0) throw new Error(`${name} requires a value`);
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
  let dryRun = false;
  let confirmDrained = false;
  let skipValidation = false;
  let force = false;
  let saveReport: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--confirm-drained") {
      confirmDrained = true;
    } else if (arg === "--skip-validation") {
      skipValidation = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--tenant-id" || arg.startsWith("--tenant-id=")) {
      const { value, consumed } = take(argv, "--tenant-id", i);
      tenantId = value;
      i += consumed - 1;
    } else if (arg === "--save-report" || arg.startsWith("--save-report=")) {
      const { value, consumed } = take(argv, "--save-report", i);
      saveReport = value;
      i += consumed - 1;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!tenantId) throw new Error("--tenant-id is required");
  if (!looksLikeUuid(tenantId)) {
    throw new Error(`--tenant-id must be a UUID; got: ${tenantId}`);
  }

  return { tenantId, dryRun, confirmDrained, skipValidation, force, saveReport };
}

// ---- runCutover (exported for tests) ---------------------------------------

/**
 * Execute the Phase 8 catalog cutover for a single tenant.
 *
 * Flow:
 *   1. Pre-flight: verify CATALOG_USE_NEW_SCHEMA=true, backfill cursor complete.
 *   2. Validation final check (runValidation with strict=true).
 *   3. Confirm CATALOG_DUAL_WRITE=false (operator gate).
 *   4. Rename legacy tables atomically (BEGIN … ALTER TABLE … COMMIT).
 *   5. Post-rename smoke: SELECT 1 from _legacy_products and catalog_products.
 *   6. Optionally write JSON report.
 *
 * The table rename list is configurable via `options.legacyTablePairs` so
 * tests can inject test-prefixed pairs without touching the production schema.
 */
export async function runCutover(
  deps: CutoverDeps,
  options: CutoverOptions
): Promise<CutoverReport> {
  const {
    tenantId,
    dryRun = false,
    confirmDrained = false,
    skipValidation = false,
    force = false,
    legacyTablePairs = PRODUCTION_TABLE_PAIRS,
  } = options;

  const report: CutoverReport = {
    tenantId,
    cutoverAt: new Date().toISOString(),
    validated: false,
    dryRun,
    renamedTables: [],
    alreadyRenamedTables: [],
  };

  log(`Starting cutover for tenant=${tenantId} dryRun=${dryRun}`);

  // ── Step 1: Pre-flight checks ─────────────────────────────────────────────

  // 1a. CATALOG_USE_NEW_SCHEMA must be true.
  if (!deps.useNewCatalogSchema) {
    const msg =
      "CATALOG_USE_NEW_SCHEMA is not true. " +
      "The new schema must be active before cutover. " +
      "Set CATALOG_USE_NEW_SCHEMA=true and restart all app instances first.";
    err(msg);
    throw new CutoverPreflightError("PREFLIGHT_USE_NEW_SCHEMA_OFF", msg);
  }

  // 1b. CATALOG_DUAL_WRITE should be false (warn if still on).
  if (deps.useDualWrite) {
    warn(
      "CATALOG_DUAL_WRITE is still true. " +
      "Dual-write should be disabled before cutover to stop legacy writes. " +
      "Set CATALOG_DUAL_WRITE=false, restart the worker, and drain BullMQ jobs, " +
      "then re-run this script."
    );
    if (!force) {
      const msg = "Aborting: useDualWrite=true without --force. Flip CATALOG_DUAL_WRITE=false first.";
      err(msg);
      throw new CutoverPreflightError("PREFLIGHT_DUAL_WRITE_ON", msg);
    }
    warn("--force passed: continuing despite CATALOG_DUAL_WRITE=true (operator takes ownership).");
  }

  // 1c. Backfill cursor must be complete (completed_at IS NOT NULL).
  const cursorRows = await deps.db
    .select()
    .from(schema.backfillCursor)
    .where(
      and(
        eq(schema.backfillCursor.tenantId, tenantId),
        isNotNull(schema.backfillCursor.completedAt)
      )
    )
    .limit(1);

  if (cursorRows.length === 0) {
    const msg =
      `No completed backfill cursor found for tenant=${tenantId}. ` +
      "The backfill must complete before cutover (backfill_cursor.completed_at IS NOT NULL). " +
      "Run: bun scripts/backfill-catalog.ts --tenant-id <uuid>";
    err(msg);
    throw new CutoverPreflightError("PREFLIGHT_BACKFILL_INCOMPLETE", msg);
  }

  log(`Pre-flight passed: backfill cursor complete at ${cursorRows[0]!.completedAt!.toISOString()}`);

  // 1d. BullMQ drain confirmation (operator asserts this manually).
  if (!confirmDrained && !dryRun) {
    const msg =
      "Missing --confirm-drained flag. " +
      "You must manually verify all BullMQ in-flight jobs are drained " +
      "(no pending link-extract / drain jobs writing to legacy tables) " +
      "before proceeding. Then re-run with --confirm-drained.";
    err(msg);
    throw new CutoverPreflightError("PREFLIGHT_NOT_DRAINED", msg);
  }

  // ── Step 2: Validation final check ────────────────────────────────────────

  if (skipValidation) {
    warn("--skip-validation passed: skipping final validation check (DANGEROUS — operator takes ownership).");
  } else {
    log("Running final validation check (strict mode)...");
    let validationPassed = false;

    try {
      const vReport = await runValidation(
        { db: deps.db },
        { tenantId, strict: true }
      );

      report.validationSummary = {
        totalScanned: vReport.totalScanned,
        totalPassed: vReport.totalPassed,
        totalFailed: vReport.totalFailed,
      };

      if (vReport.totalFailed > 0) {
        err(
          `Validation failed: ${vReport.totalFailed} product(s) with required-field loss. ` +
          "Fix root cause and re-run. Failures: " +
          JSON.stringify(vReport.failuresByField)
        );
        if (!force) {
          process.exit(1);
        }
        warn("--force passed: continuing despite validation failures (operator takes ownership).");
      } else {
        validationPassed = true;
        log(`Validation passed: ${vReport.totalPassed}/${vReport.totalScanned} products passed.`);
      }
    } catch (validationErr) {
      err(`Validation runtime error: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`);
      if (!force) {
        process.exit(1);
      }
      warn("--force passed: continuing despite validation error.");
    }

    report.validated = validationPassed;
  }

  // ── Step 3: Classify tables (already renamed vs. pending) ─────────────────
  //
  // Idempotency: if a target name (_legacy_*) already exists, skip that pair
  // with a warning. This allows re-running the cutover after a partial failure.

  const toRename: Array<{ from: string; to: string }> = [];

  for (const pair of legacyTablePairs) {
    const sourceExists = await tableExists(deps.db, pair.from);
    const targetExists = await tableExists(deps.db, pair.to);

    if (targetExists) {
      warn(`Table ${pair.to} already exists — assuming already renamed, skipping ${pair.from}.`);
      report.alreadyRenamedTables.push(pair);
      continue;
    }

    if (!sourceExists) {
      warn(`Source table ${pair.from} does not exist and target ${pair.to} does not exist — skipping (unexpected state).`);
      continue;
    }

    toRename.push(pair);
  }

  if (toRename.length === 0 && report.alreadyRenamedTables.length === legacyTablePairs.length) {
    log("All legacy tables are already renamed. Cutover was previously completed.");
    // renamedTables stays [] — nothing was renamed THIS run.
    // alreadyRenamedTables carries the full list of pairs detected as already done.
    // Callers should check alreadyRenamedTables.length === legacyTablePairs.length
    // as the idempotency signal.
    return report;
  }

  // ── Step 4: Rename legacy tables atomically ───────────────────────────────

  if (dryRun) {
    log("DRY-RUN: Would execute the following renames in a single transaction:");
    for (const pair of toRename) {
      log(`  ALTER TABLE ${pair.from} RENAME TO ${pair.to};`);
    }
    log("DRY-RUN: No changes made.");
    report.renamedTables = toRename;
    return report;
  }

  if (toRename.length > 0) {
    log(`Renaming ${toRename.length} legacy table(s) in a single transaction...`);

    try {
      await deps.db.transaction(async (tx) => {
        for (const pair of toRename) {
          // Use raw SQL inside the transaction — Drizzle ORM has no DDL builder
          // for ALTER TABLE RENAME. Postgres rolls back the whole batch on any
          // failure, so there is no partial-rename state if a later ALTER fails.
          await tx.execute(
            sql.raw(`ALTER TABLE "${pair.from}" RENAME TO "${pair.to}"`)
          );
          log(`  Renamed: ${pair.from} → ${pair.to}`);
        }
      });

      report.renamedTables = toRename;
      log(`Successfully renamed ${toRename.length} table(s).`);
    } catch (renameErr) {
      err(
        `Fatal error during table rename. The transaction was rolled back by Postgres. ` +
        `No partial renames occurred. Error: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`
      );
      // Exit code 2 — partial state possible (though Postgres ROLLBACK prevents it
      // for the tables in this transaction; other out-of-transaction effects may
      // have occurred before this block was reached).
      process.exit(2);
    }
  }

  // ── Step 5: Post-rename smoke ─────────────────────────────────────────────

  log("Running post-rename smoke checks...");

  // 5a. Verify at least one _legacy_* table is readable (if we renamed any).
  if (report.renamedTables.length > 0) {
    const firstRenamed = report.renamedTables[0]!;
    try {
      await deps.db.execute(sql.raw(`SELECT 1 FROM "${firstRenamed.to}" LIMIT 1`));
      log(`Smoke: SELECT 1 FROM ${firstRenamed.to} — OK`);
    } catch (smokeErr) {
      warn(`Smoke check on ${firstRenamed.to} failed: ${smokeErr instanceof Error ? smokeErr.message : String(smokeErr)}`);
    }
  }

  // 5b. Verify catalog_products is still readable for this tenant.
  try {
    const catalogRows = await deps.db
      .select({ productId: schema.catalogProducts.productId })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.tenantId, tenantId))
      .limit(1);
    log(`Smoke: catalog_products readable for tenant=${tenantId}, found ${catalogRows.length} row(s) — OK`);
  } catch (smokeErr) {
    warn(`Smoke check on catalog_products failed: ${smokeErr instanceof Error ? smokeErr.message : String(smokeErr)}`);
  }

  // ── Step 6: Write JSON report ─────────────────────────────────────────────

  if (options.saveReport) {
    const tmpPath = `${options.saveReport}.tmp`;
    await writeFile(tmpPath, JSON.stringify(report, null, 2), "utf-8");
    await rename(tmpPath, options.saveReport);
    log(`Report written to ${options.saveReport}`);
  }

  log(
    `Cutover complete for tenant=${tenantId}: ` +
    `renamed=${report.renamedTables.length} already=${report.alreadyRenamedTables.length}`
  );

  return report;
}

// ---- CLI entrypoint --------------------------------------------------------

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (parseErr) {
    // eslint-disable-next-line no-console
    console.error(`[cutover] ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    printUsage();
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    err("DATABASE_URL is required");
    process.exit(1);
  }

  // Post Phase 9.3: flags removed. Hardcode to post-cutover values.
  const useNewCatalogSchema = true;
  const useDualWrite = false;

  const { client, close } = createDb(databaseUrl);
  try {
    const report = await runCutover(
      { db: client, useNewCatalogSchema, useDualWrite },
      {
        tenantId: args.tenantId,
        dryRun: args.dryRun,
        confirmDrained: args.confirmDrained,
        skipValidation: args.skipValidation,
        force: args.force,
        saveReport: args.saveReport,
      }
    );

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      tenantId: report.tenantId,
      cutoverAt: report.cutoverAt,
      validated: report.validated,
      dryRun: report.dryRun,
      renamedTables: report.renamedTables,
      alreadyRenamedTables: report.alreadyRenamedTables,
      ...(report.validationSummary ? { validationSummary: report.validationSummary } : {}),
    }, null, 2));
  } catch (runErr) {
    if (runErr instanceof CutoverPreflightError) {
      // Pre-flight failures are already logged inside runCutover.
      // Exit 1 is the signal for "bad input / pre-flight failed."
      process.exit(1);
    }
    err(`Unexpected error: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
    process.exit(2);
  } finally {
    await close();
  }
}

// Only run as CLI entrypoint — not when imported by tests.
if (import.meta.main) {
  await main();
}
