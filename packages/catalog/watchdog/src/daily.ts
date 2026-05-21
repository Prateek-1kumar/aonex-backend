// Catalog redesign Phase 3.10 — daily full-sweep tier (spec §13.3, plan §3.10).
//
// Iterates ALL products (status != 'merged_into') in chunks. No sampling —
// the full sweep is the safety net that catches long-tail drift the
// statistical samplers might have missed.
//
// Design decisions:
//   1. Chunk size default 500 (per the spec's "chunked" note). Exposed via
//      deps so tests can drive a small chunkSize for boundary verification.
//   2. Chunking strategy: keyset pagination over product_id (UUID) with
//      `WHERE product_id > $last LIMIT $chunkSize`. UUID v4 has uniform
//      distribution so the keyset advances roughly evenly. Avoids
//      OFFSET (which slows linearly).
//   3. Per-product errors don't abort the sweep — same policy as the
//      continuous/hourly tiers (spec §13.3 + design decision in
//      continuous.ts).

import { sql } from "drizzle-orm";
import type { Queue } from "bullmq";
import type { DrizzleClient } from "@aonex/db";
import { detectDrift } from "./drift-detector.js";
import { autoFixDrift } from "./auto-fix.js";
import type { WatchdogStats } from "./drift-detector.js";

export interface DailyDeps {
  db: DrizzleClient;
  /** Optional reconciler queue for async-tier auto-fixes. */
  queue?: Queue;
  /** Default 500. Exposed so tests can verify chunk-boundary behaviour. */
  chunkSize?: number;
}

export interface DailyStats extends WatchdogStats {
  /** Drift counts broken down by tenant — useful for per-tenant
   *  observability dashboards. */
  driftByTenant: Record<string, number>;
}

export async function runDaily(deps: DailyDeps): Promise<DailyStats> {
  const { db, queue } = deps;
  const chunkSize = deps.chunkSize ?? 500;
  const t0 = Date.now();
  const stats: DailyStats = {
    sampled: 0,
    driftFound: 0,
    autoFixed: 0,
    durationMs: 0,
    driftRateByAttribute: {},
    driftByTenant: {}
  };

  let lastProductId: string | null = null;

  // Loop forever until a chunk returns empty. Each chunk is a separate
  // keyset query — see decision 2 above.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const chunkResult = await db.execute(
      lastProductId === null
        ? sql`
            SELECT product_id, tenant_id
            FROM catalog_products
            WHERE status != 'merged_into'
            ORDER BY product_id
            LIMIT ${chunkSize}
          `
        : sql`
            SELECT product_id, tenant_id
            FROM catalog_products
            WHERE status != 'merged_into'
              AND product_id > ${lastProductId}
            ORDER BY product_id
            LIMIT ${chunkSize}
          `
    );
    const rows = (chunkResult.rows ?? []) as Array<{
      product_id: string;
      tenant_id: string;
    }>;
    if (rows.length === 0) break;

    for (const row of rows) {
      stats.sampled++;
      try {
        const report = await detectDrift({ db }, row.product_id);
        if (report.hasDrift) {
          stats.driftFound++;
          stats.driftByTenant[row.tenant_id] =
            (stats.driftByTenant[row.tenant_id] ?? 0) + 1;
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
            await autoFixDrift(autoFixDeps, row.product_id, report);
            stats.autoFixed++;
          } catch (err) {
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

    // Advance the keyset pointer. Safe because rows came back in
    // product_id ASC order.
    lastProductId = rows[rows.length - 1]!.product_id;

    // Defensive: if the chunk came back shorter than the requested size,
    // we've reached the end.
    if (rows.length < chunkSize) break;
  }

  stats.durationMs = Date.now() - t0;
  return stats;
}
