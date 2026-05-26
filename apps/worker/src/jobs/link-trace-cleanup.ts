// Daily cleanup of link-ingestion trace tables.
//
// Phase 9 reframing (Task 9.2): link_ingestion_trace_facts/sets/runs are NOT
// canonical catalog state — they are transient evidence collected during link
// ingestion. The catalog model (catalog_products + side tables) is the source
// of truth. We retain 14 days of traces for debugging / provenance lookup;
// older rows are deleted by this job.
//
// v1 scope (Task 9.2): DELETE link_ingestion_trace_facts ONLY.
//
// link_ingestion_trace_sets and link_ingestion_trace_runs are NOT deleted here
// because proposed_diffs.source_fact_set_id references link_ingestion_trace_sets.id
// with ON DELETE RESTRICT. Attempting to DELETE sets while any proposed_diff row
// still references them will throw a FK violation. Sets + runs cleanup is deferred
// to Task 9.3, which removes proposed_diffs from the schema (and therefore removes
// the RESTRICT FK before attempting the broader cleanup).
//
// FK shape for reference:
//   link_ingestion_trace_runs (1) ──cascade──▶ link_ingestion_trace_sets (n)
//   link_ingestion_trace_sets (1) ──cascade──▶ link_ingestion_trace_facts (n)
//   proposed_diffs.source_fact_set_id ──restrict──▶ link_ingestion_trace_sets.id
//
// The facts DELETE runs inside a transaction so a mid-run crash leaves no
// partial state; the next daily run retries the full window from scratch.

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
  /** ISO timestamp of the cutoff applied (now() - retentionDays days). */
  cutoff_at: string;
  // sets_deleted and runs_deleted are intentionally absent in v1. See file
  // header: sets/runs cleanup is deferred to Task 9.3 once proposed_diffs
  // (which carries a RESTRICT FK to link_ingestion_trace_sets) is removed.
}

export async function runLinkTraceCleanup(
  deps: LinkTraceCleanupDeps,
  options: LinkTraceCleanupOptions = {}
): Promise<LinkTraceCleanupResult> {
  const retentionDays = options.retentionDays ?? 14;
  const cutoffAt = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoffAt.toISOString();

  // Single transaction wrapping the facts DELETE. Crash-safe — next daily run
  // retries the full window from scratch.
  const result = await deps.db.transaction(async (tx) => {
    // Delete facts (leaf table; FK child of sets via fact_set_id). Safe to
    // delete directly — no other table references link_ingestion_trace_facts.
    const factsResult = await tx.execute(
      sql`DELETE FROM link_ingestion_trace_facts WHERE created_at < ${cutoffAt}`
    );

    return {
      facts_deleted: (factsResult as { rowCount?: number }).rowCount ?? 0,
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
  async process({ db, logger }) {
    const result = await runLinkTraceCleanup({ db });
    logger.info(result, "link-trace-cleanup");
  },
};
