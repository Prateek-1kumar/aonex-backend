// Daily cleanup of link-ingestion trace tables.
//
// Phase 9 reframing (Task 9.2): link_ingestion_trace_facts/sets/runs are NOT
// canonical catalog state — they are transient evidence collected during link
// ingestion. The catalog model (catalog_products + side tables) is the source
// of truth. We retain 14 days of traces for debugging / provenance lookup;
// older rows are deleted by this job.
//
// Timestamp column used: `created_at` — present on all three tables per
// packages/db/src/schema/link-ingestion-trace.ts.
//
// FK order: facts → sets → runs. DELETE in reverse (children first).
// All three queries are bounded by `created_at < now() - interval '<N> days'`.
// There is NO FK CASCADE in place; the predicate consistency (applying the
// same window to all three tables) ensures dangling FK violations do not occur
// as long as rows were created together (which the ingestion spine guarantees).
//
// The three DELETEs run inside a single transaction so a mid-run crash cannot
// leave orphaned rows (e.g., facts deleted but parent sets still present, which
// would make subsequent fact-set deletes leave dangling run rows that never get
// cleaned up). A transaction-level rollback restores all three tables to their
// pre-cleanup state; the next daily run retries the full window.

import { sql } from "drizzle-orm";
import type { DrizzleClient } from "@aonex/db";
import type { Logger } from "pino";
import type { CronJob } from "./index.js";

export interface LinkTraceCleanupDeps {
  db: DrizzleClient;
  logger?: Logger;
}

export interface LinkTraceCleanupOptions {
  /** Retention window in days. Default 14 per spec §22. */
  retentionDays?: number;
}

export interface LinkTraceCleanupResult {
  facts_deleted: number;
  sets_deleted: number;
  runs_deleted: number;
  /** ISO timestamp of the cutoff applied (now() - retentionDays days). */
  cutoff_at: string;
}

export async function runLinkTraceCleanup(
  deps: LinkTraceCleanupDeps,
  options: LinkTraceCleanupOptions = {}
): Promise<LinkTraceCleanupResult> {
  const retentionDays = options.retentionDays ?? 14;
  const cutoffAt = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoffAt.toISOString();

  // Single transaction: all three DELETEs or none. Crash-safe — next daily run
  // retries the full window from scratch.
  const result = await deps.db.transaction(async (tx) => {
    // 1. Delete facts first (FK child of sets).
    const factsResult = await tx.execute(
      sql`DELETE FROM link_ingestion_trace_facts WHERE created_at < ${cutoffAt} RETURNING id`
    );

    // 2. Delete sets (FK child of runs, FK parent of facts — already gone).
    const setsResult = await tx.execute(
      sql`DELETE FROM link_ingestion_trace_sets WHERE created_at < ${cutoffAt} RETURNING id`
    );

    // 3. Delete runs (FK parent of sets — already gone).
    const runsResult = await tx.execute(
      sql`DELETE FROM link_ingestion_trace_runs WHERE created_at < ${cutoffAt} RETURNING id`
    );

    return {
      facts_deleted: (factsResult as { rowCount?: number }).rowCount ?? 0,
      sets_deleted: (setsResult as { rowCount?: number }).rowCount ?? 0,
      runs_deleted: (runsResult as { rowCount?: number }).rowCount ?? 0,
      cutoff_at: cutoffIso,
    };
  });

  deps.logger?.info(result, "link_trace_cleanup.completed");
  return result;
}

/**
 * CronJob registration entry.
 * Schedule: 02:00 UTC daily — low-traffic window.
 */
export const linkTraceCleanup: CronJob = {
  name: "link-trace-cleanup",
  cronSchedule: "0 2 * * *", // 02:00 UTC daily
  async process({ db }) {
    const result = await runLinkTraceCleanup({ db });
    // eslint-disable-next-line no-console
    console.info("[link-trace-cleanup]", JSON.stringify(result));
  },
};
