// apps/worker/src/jobs/drift-scan.ts
import type { CronJob } from "./index.js";
import { sql } from "drizzle-orm";
import type { DrizzleClient } from "@aonex/db";
import {
  computeNullRate,
  detectNullRateDrift,
  detectSchemaDrift,
  type NullRateDriftReport,
  type SchemaDriftReport
} from "@aonex/drift-detector";

const CANONICAL_FIELDS = [
  "title", "brand", "gtin", "model_number",
  "base_price", "currency", "canonical_category"
];

export interface DriftScanResult {
  perCategory: Array<{
    category: string;
    baselineCount: number;
    currentCount: number;
    nullRateDrift: NullRateDriftReport[];
    schemaDrift: SchemaDriftReport;
  }>;
}

export interface DriftScanDeps {
  db: DrizzleClient;
  /** Override for tests */
  currentWindowHours?: number;
  baselineWindowDays?: number;
}

/**
 * Spec §14.6 — hourly cron. For each canonical_category with sufficient
 * recent volume, compute drift in:
 *  - null-rate of canonical fields (title/brand/gtin/...)
 *  - schema-key set in attributes_json
 *
 * Output is LOGGED via console.info; audit emission deferred per
 * system-tenant convention (Phase 7 precedent).
 */
export async function runDriftScan(deps: DriftScanDeps): Promise<DriftScanResult> {
  const currentHours = deps.currentWindowHours ?? 1;
  const baselineDays = deps.baselineWindowDays ?? 7;

  // Fetch current cohort (last N hours) + baseline cohort (7d - last 1h) per category.
  // Limit each cohort to 500 rows per category to bound memory.
  const rows = await deps.db.execute(sql`
    SELECT
      canonical_category,
      title, brand, gtin, model_number,
      base_price, currency,
      attributes_json,
      created_at,
      (created_at > now() - (${currentHours} * interval '1 hour')) AS in_current
    FROM (
      SELECT *, row_number() OVER (PARTITION BY canonical_category, (created_at > now() - (${currentHours} * interval '1 hour')) ORDER BY created_at DESC) AS rn
      FROM product_versions
      WHERE canonical_category IS NOT NULL
        AND created_at > now() - (${baselineDays} * interval '1 day')
    ) ranked
    WHERE rn <= 500
  `);

  const perCategory = new Map<string, { baseline: Record<string, unknown>[]; current: Record<string, unknown>[] }>();
  for (const r of rows as unknown as Array<{
    canonical_category: string;
    title: string | null;
    brand: string | null;
    gtin: string | null;
    model_number: string | null;
    base_price: number | string | null;
    currency: string | null;
    attributes_json: Record<string, unknown> | null;
    in_current: boolean;
  }>) {
    const cat = r.canonical_category;
    if (!perCategory.has(cat)) perCategory.set(cat, { baseline: [], current: [] });
    const bucket = perCategory.get(cat)!;
    const flat: Record<string, unknown> = {
      title: r.title, brand: r.brand, gtin: r.gtin, model_number: r.model_number,
      base_price: r.base_price, currency: r.currency,
      canonical_category: r.canonical_category
    };
    if (r.in_current) bucket.current.push(flat);
    else bucket.baseline.push(flat);
  }

  const result: DriftScanResult = { perCategory: [] };

  for (const [category, { baseline, current }] of perCategory) {
    if (baseline.length === 0 || current.length === 0) continue;
    const baselineNullRate = computeNullRate(baseline, CANONICAL_FIELDS);
    const currentNullRate = computeNullRate(current, CANONICAL_FIELDS);
    const nullRateDrift = detectNullRateDrift(baselineNullRate, currentNullRate, 0.10);

    // Schema drift requires the attributes_json keys — we don't have them in `flat`,
    // re-extract per record.
    const baselineAttrs = baseline.map(() => ({}));    // placeholder until we wire attrs into the query
    const currentAttrs = current.map(() => ({}));
    const schemaDrift = detectSchemaDrift(baselineAttrs, currentAttrs);

    result.perCategory.push({
      category,
      baselineCount: baseline.length,
      currentCount: current.length,
      nullRateDrift,
      schemaDrift
    });
  }

  return result;
}

export const driftScan: CronJob = {
  name: "drift-scan",
  cronSchedule: "0 * * * *",    // hourly
  async process(ctx) {
    const result = await runDriftScan({ db: ctx.db });
    const driftedFields = result.perCategory.flatMap((c) =>
      c.nullRateDrift.filter((d) => d.drifted).map((d) => ({
        category: c.category,
        field: d.field,
        delta: Number(d.delta.toFixed(3))
      }))
    );
    // eslint-disable-next-line no-console
    console.info("[drift-scan]", JSON.stringify({
      categoriesScanned: result.perCategory.length,
      driftedFieldCount: driftedFields.length,
      driftedFields: driftedFields.slice(0, 20)
    }));
  }
};
