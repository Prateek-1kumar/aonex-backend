import { sql } from "drizzle-orm";
import type { CronJob } from "./index.js";

const USAGE_THRESHOLD = 10;
const CROSS_TENANT_THRESHOLD = 3;
const QUARANTINE_DAYS = 30;

export const overridePromotionScan: CronJob = {
  name: "override-promotion-scan",
  cronSchedule: "30 2 * * *",   // 02:30 UTC daily
  async process({ db }) {
    // Mark overrides eligible when:
    //  - usage_count >= 10 (proven to fire repeatedly)
    //  - last_used_at older than 30 days OR null (no recent reversal)
    //  - source_key appears in ≥3 distinct tenants (cross-tenant agreement)
    await db.execute(sql`
      UPDATE mapping_overrides
      SET promote_eligible_at = NOW()
      WHERE promote_eligible_at IS NULL
        AND usage_count >= ${USAGE_THRESHOLD}
        AND (last_used_at IS NULL OR last_used_at < NOW() - (${QUARANTINE_DAYS} || ' days')::interval)
        AND source_key IN (
          SELECT source_key FROM mapping_overrides
          GROUP BY source_key
          HAVING count(DISTINCT tenant_id) >= ${CROSS_TENANT_THRESHOLD}
        )
    `);
    // Promotion to attribute_synonyms.approved_at remains a MANUAL admin step,
    // per the spec — this job only flags eligibility.
  },
};
