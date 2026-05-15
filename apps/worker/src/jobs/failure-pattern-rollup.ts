import { sql } from "drizzle-orm";
import type { CronJob } from "./index.js";

export const failurePatternRollup: CronJob = {
  name: "failure-pattern-rollup",
  cronSchedule: "0 3 * * *",   // 03:00 UTC daily
  async process({ db }) {
    // Step 1: roll up duplicate (tenant, domain, reason, raw_key) groups
    // into a single representative row (the one with min(id)).
    await db.execute(sql`
      WITH grouped AS (
        SELECT
          tenant_id,
          domain_pattern,
          reason,
          coalesce(raw_key, '') AS raw_key_norm,
          min(first_seen_at) AS first_seen_at,
          max(last_seen_at) AS last_seen_at,
          sum(occurrence_count) AS occurrence_count,
          min(id) AS keep_id
        FROM extraction_failures
        GROUP BY tenant_id, domain_pattern, reason, coalesce(raw_key, '')
      )
      UPDATE extraction_failures ef
      SET occurrence_count = g.occurrence_count,
          first_seen_at = g.first_seen_at,
          last_seen_at = g.last_seen_at
      FROM grouped g
      WHERE ef.id = g.keep_id
    `);

    // Step 2: delete all rows that are NOT the representative (min id per group).
    await db.execute(sql`
      DELETE FROM extraction_failures
      WHERE id NOT IN (
        SELECT min(id)
        FROM extraction_failures
        GROUP BY tenant_id, domain_pattern, reason, coalesce(raw_key, '')
      )
    `);
  },
};
