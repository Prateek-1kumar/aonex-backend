// Catalog redesign Phase 3.10 — continuous tier (spec §13.3, plan §3.10).
//
// Runs every 5 minutes; samples 1% of products updated in the last 5 min.
// Per spec §13.3 this catches ~95% of drift within minutes — sub-10-minute
// visibility instead of sub-6-hour visibility.
//
// Design decisions:
//   1. Sample mechanism: SELECT … FROM catalog_products WHERE updated_at >
//      now() - interval '5 minutes' AND status != 'merged_into' ORDER BY
//      random() LIMIT GREATEST(1, n_recent / 100). The GREATEST(1, …) means
//      with a single recent product we still sample 1 — useful for tests
//      and for tiny-tenant tenants where the 1% floor would round to zero.
//   2. We don't use Postgres TABLESAMPLE BERNOULLI because it operates on
//      the whole table, not "recent rows". For a "last N minutes" filter
//      we need WHERE + ORDER BY random().
//   3. status='merged_into' exclusion: tombstoned products legitimately
//      have stale _current rows (cleared by merge). They are NEVER swept.
//   4. Per-product errors do not abort the sweep — one bad product
//      shouldn't take down the watchdog. We catch + log + continue.

import { sql } from "drizzle-orm";
import type { Queue } from "bullmq";
import type { DrizzleClient } from "@aonex/db";
import { detectDrift } from "./drift-detector.js";
import { autoFixDrift } from "./auto-fix.js";
import type { WatchdogStats } from "./drift-detector.js";

export interface ContinuousDeps {
  db: DrizzleClient;
  /** Optional reconciler queue for async-tier auto-fixes. */
  queue?: Queue;
  /** Override sample-rate divisor. Default 100 (= 1%). Exposed for tests. */
  sampleDivisor?: number;
}

/** Default windows are encoded as Postgres interval literals via the
 *  underlying SQL — see runSweep. */
export async function runContinuous(deps: ContinuousDeps): Promise<WatchdogStats> {
  return runSweep(deps, "5 minutes", deps.sampleDivisor ?? 100);
}

// ---- Shared sweep -----------------------------------------------------------

/** Shared sweep implementation used by both the continuous and hourly tiers
 *  (the only diff is the window size + sample divisor). Daily uses a
 *  separate full-table iterator since it doesn't sample. */
export async function runSweep(
  deps: ContinuousDeps,
  windowInterval: string,
  sampleDivisor: number
): Promise<WatchdogStats> {
  const { db, queue } = deps;
  const t0 = Date.now();
  const stats: WatchdogStats = {
    sampled: 0,
    driftFound: 0,
    autoFixed: 0,
    asyncDeferred: 0,
    durationMs: 0,
    driftRateByAttribute: {}
  };

  // Sample. ORDER BY random() over a small "recent" subset is cheap.
  // GREATEST(1, …) ensures tiny populations still get one sample.
  // We use sql.raw for the interval literal since Postgres can't take a
  // parameter for the value inside an INTERVAL literal cleanly; the input
  // is hardcoded by the tier so this is safe.
  const result = await db.execute(sql`
    WITH recent AS (
      SELECT product_id
      FROM catalog_products
      WHERE updated_at > now() - interval '${sql.raw(windowInterval)}'
        AND status != 'merged_into'
    ),
    cnt AS (SELECT count(*)::int AS n FROM recent)
    SELECT product_id
    FROM recent
    ORDER BY random()
    LIMIT GREATEST(1, (SELECT n FROM cnt) / ${sampleDivisor})
  `);

  // Drizzle returns rows in `.rows`. The synthetic GREATEST(1, …) bug-trap:
  // when there are NO recent products, we still get LIMIT 1 but the inner
  // recent CTE is empty so the join yields zero rows.
  const rows = (result.rows ?? []) as Array<{ product_id: string }>;

  for (const row of rows) {
    stats.sampled++;
    try {
      const report = await detectDrift({ db }, row.product_id);
      if (report.hasDrift) {
        stats.driftFound++;
        // Accumulate per-attribute drift counts for metric publication.
        for (const d of report.driftAttributes) {
          stats.driftRateByAttribute[d.attributeCode] =
            (stats.driftRateByAttribute[d.attributeCode] ?? 0) + 1;
        }
        if (report.driftPricingCurrentRows.length > 0) {
          stats.driftRateByAttribute.pricing =
            (stats.driftRateByAttribute.pricing ?? 0) +
            report.driftPricingCurrentRows.length;
        }
        if (report.driftInventoryCurrentRows.length > 0) {
          stats.driftRateByAttribute.inventory =
            (stats.driftRateByAttribute.inventory ?? 0) +
            report.driftInventoryCurrentRows.length;
        }
        try {
          const autoFixDeps = queue ? { db, queue } : { db };
          const fix = await autoFixDrift(autoFixDeps, row.product_id, report);
          // A product whose async drift was skipped due to no queue is NOT
          // counted as "autoFixed" — it bumps `asyncDeferred` instead so
          // the stats are honest. Sync-only drift still counts toward
          // autoFixed (asyncDeferred=0 in that case).
          if (fix.asyncDeferred > 0) {
            stats.asyncDeferred++;
          } else {
            stats.autoFixed++;
          }
        } catch (err) {
          // Per spec §13.3 + design decision 4: one bad product shouldn't
          // abort the sweep. Log + continue.
          console.warn(
            `[catalog-watchdog] AUTOFIX_FAILED product=${row.product_id} err=${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    } catch (err) {
      console.warn(
        `[catalog-watchdog] DETECT_FAILED product=${row.product_id} err=${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  stats.durationMs = Date.now() - t0;
  return stats;
}
