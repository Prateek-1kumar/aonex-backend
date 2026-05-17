/**
 * Spec §14.6 — per-field null-rate drift.
 *
 * For each canonical field, compute: % of records in the cohort that have
 * a NULL/missing value for that field. Sudden spikes indicate either:
 * (a) selector breakage on a parser, or (b) genuine catalog shift (e.g.,
 * supplier dropped a column).
 */

export interface NullRateResult {
  /** Field name (e.g., "base_price") */
  field: string;
  /** Number of records where this field was NULL/missing/empty string */
  nullCount: number;
  /** Total records in the cohort */
  total: number;
  /** nullCount / total (0..1) */
  rate: number;
}

export interface NullRateDriftReport {
  field: string;
  baselineRate: number;
  currentRate: number;
  /** Absolute change (current - baseline) */
  delta: number;
  /** True when delta exceeds threshold */
  drifted: boolean;
}

/**
 * Compute null-rate for each field across a set of records.
 * A field is "null" if the value is null, undefined, or empty string.
 */
export function computeNullRate(
  records: ReadonlyArray<Record<string, unknown>>,
  fields: ReadonlyArray<string>
): NullRateResult[] {
  if (records.length === 0) {
    return fields.map((f) => ({ field: f, nullCount: 0, total: 0, rate: 0 }));
  }
  return fields.map((field) => {
    let nullCount = 0;
    for (const rec of records) {
      const v = rec[field];
      if (v == null || v === "") nullCount++;
    }
    return { field, nullCount, total: records.length, rate: nullCount / records.length };
  });
}

/**
 * Detect drift by comparing current null-rate to baseline. Emit a report
 * when absolute delta exceeds threshold.
 */
export function detectNullRateDrift(
  baseline: ReadonlyArray<NullRateResult>,
  current: ReadonlyArray<NullRateResult>,
  threshold = 0.10
): NullRateDriftReport[] {
  const baselineMap = new Map(baseline.map((r) => [r.field, r.rate]));
  const reports: NullRateDriftReport[] = [];
  for (const c of current) {
    const baseRate = baselineMap.get(c.field) ?? 0;
    const delta = c.rate - baseRate;
    reports.push({
      field: c.field,
      baselineRate: baseRate,
      currentRate: c.rate,
      delta,
      drifted: Math.abs(delta) >= threshold
    });
  }
  return reports;
}
