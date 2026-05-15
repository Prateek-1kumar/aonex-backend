import { sql } from "drizzle-orm";
import type { CronJob } from "./index.js";

export const priceClusterRebuild: CronJob = {
  name: "price-cluster-rebuild",
  cronSchedule: "0 2 * * *", // 02:00 UTC daily
  async process({ db }) {
    // Wipe and rebuild the cluster table from product_versions.
    // Median per (tenant, brand, canonical_category, currency); only clusters with ≥10 samples kept.
    await db.execute(sql`DELETE FROM price_clusters`);
    await db.execute(sql`
      INSERT INTO price_clusters (id, tenant_id, brand, canonical_category, currency, median_price, sample_count, computed_at)
      SELECT
        gen_random_uuid(),
        tenant_id,
        brand,
        canonical_category,
        currency,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY base_price) AS median_price,
        count(*) AS sample_count,
        NOW()
      FROM product_versions
      WHERE base_price IS NOT NULL
        AND brand IS NOT NULL
        AND canonical_category IS NOT NULL
        AND currency IS NOT NULL
      GROUP BY tenant_id, brand, canonical_category, currency
      HAVING count(*) >= 10
    `);
  },
};
