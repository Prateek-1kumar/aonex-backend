import { sql } from "drizzle-orm";
import type { CronJob } from "./index.js";

/**
 * Nightly job: refresh domain_profiles from last 30 days of link_ingestion_trace_runs.
 *
 * Schema notes (verified against packages/db/src/schema/):
 *   - link_ingestion_trace_runs.extractor_version  — LLM runs carry a value matching '%llm%'
 *   - link_ingestion_trace_runs.started_at         — run timestamp (nullable; rows with NULL excluded by > filter)
 *   - source_artifacts.source_external_id — the URL/external identifier for the artifact
 *   - proposed_diffs links to link_ingestion_trace_sets via proposed_diffs.source_fact_set_id,
 *     and link_ingestion_trace_sets links to link_ingestion_trace_runs via
 *     link_ingestion_trace_sets.extraction_run_id.
 *     There is NO direct FK from proposed_diffs to link_ingestion_trace_runs, so we join through
 *     link_ingestion_trace_sets as a bridge table.
 *   - proposed_diffs.confidence_score    — numeric(5,4)
 */
export const domainProfileRefresh: CronJob = {
  name: "domain-profile-refresh",
  cronSchedule: "30 3 * * *", // 03:30 UTC daily
  async process({ db }) {
    await db.execute(sql`
      WITH d AS (
        SELECT
          regexp_replace(
            split_part(
              regexp_replace(sa.source_external_id, '^https?://(www\\.)?', ''),
              '/', 1
            ),
            ':.*$', ''
          ) AS domain_pattern,
          count(*) FILTER (WHERE er.extractor_version ILIKE '%llm%') AS llm_runs,
          count(*) AS total_runs,
          avg((diff.confidence_score)::numeric) AS avg_confidence
        FROM link_ingestion_trace_runs er
        JOIN source_artifacts sa ON sa.id = er.artifact_id
        -- Bridge through link_ingestion_trace_sets: link_ingestion_trace_runs has no direct FK to proposed_diffs.
        -- proposed_diffs.source_fact_set_id -> link_ingestion_trace_sets.id
        -- link_ingestion_trace_sets.extraction_run_id -> link_ingestion_trace_runs.id
        LEFT JOIN link_ingestion_trace_sets efs ON efs.extraction_run_id = er.id
        LEFT JOIN proposed_diffs diff ON diff.source_fact_set_id = efs.id
        WHERE er.started_at > NOW() - INTERVAL '30 days'
        GROUP BY 1
      )
      INSERT INTO domain_profiles (domain_pattern, preferred_parsers, llm_hit_rate, avg_confidence, sample_count, updated_at)
      SELECT
        domain_pattern,
        '["json_ld","next_data","shopify_probe","microdata","opengraph"]'::jsonb,
        CASE WHEN total_runs > 0 THEN (llm_runs::numeric / total_runs)::numeric(5,4) ELSE 0 END,
        avg_confidence,
        total_runs,
        NOW()
      FROM d
      WHERE domain_pattern IS NOT NULL AND domain_pattern <> ''
      ON CONFLICT (domain_pattern) DO UPDATE
      SET llm_hit_rate = EXCLUDED.llm_hit_rate,
          avg_confidence = EXCLUDED.avg_confidence,
          sample_count = EXCLUDED.sample_count,
          updated_at = NOW();
    `);
  },
};
