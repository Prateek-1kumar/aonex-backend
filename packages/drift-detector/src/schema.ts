/**
 * Spec §14.6 — schema drift detector.
 *
 * Watches `attributes_json` keysets across product_versions over time.
 * Flags when a key appears in the current cohort above a threshold but
 * was absent (or rare) in the baseline. Signals either:
 * (a) supplier added a new attribute (catalog shift), or
 * (b) parser regression mis-promoted a noise key.
 */

export interface SchemaDriftReport {
  /** New key that appeared with high frequency */
  newKeys: Array<{ key: string; currentFrequency: number; baselineFrequency: number }>;
  /** Keys that vanished (present in baseline above threshold, absent in current) */
  vanishedKeys: Array<{ key: string; baselineFrequency: number; currentFrequency: number }>;
}

/**
 * Detect schema drift by comparing two sets of attribute-key frequencies.
 * Keys are flagged as "new" if current freq ≥ newKeyThreshold AND baseline freq < epsilon.
 * Keys are flagged as "vanished" if baseline freq ≥ newKeyThreshold AND current freq < epsilon.
 */
export function detectSchemaDrift(
  baselineRecords: ReadonlyArray<Record<string, unknown>>,
  currentRecords: ReadonlyArray<Record<string, unknown>>,
  options: { newKeyThreshold?: number; vanishedKeyThreshold?: number; presenceEpsilon?: number } = {}
): SchemaDriftReport {
  const newKeyThreshold = options.newKeyThreshold ?? 0.20;
  const vanishedKeyThreshold = options.vanishedKeyThreshold ?? 0.20;
  const presenceEpsilon = options.presenceEpsilon ?? 0.02;

  const baselineFreq = keyFrequencies(baselineRecords);
  const currentFreq = keyFrequencies(currentRecords);

  const allKeys = new Set([...Object.keys(baselineFreq), ...Object.keys(currentFreq)]);
  const newKeys: SchemaDriftReport["newKeys"] = [];
  const vanishedKeys: SchemaDriftReport["vanishedKeys"] = [];

  for (const key of allKeys) {
    const baseRate = baselineFreq[key] ?? 0;
    const currRate = currentFreq[key] ?? 0;
    if (currRate >= newKeyThreshold && baseRate < presenceEpsilon) {
      newKeys.push({ key, currentFrequency: currRate, baselineFrequency: baseRate });
    }
    if (baseRate >= vanishedKeyThreshold && currRate < presenceEpsilon) {
      vanishedKeys.push({ key, baselineFrequency: baseRate, currentFrequency: currRate });
    }
  }

  return { newKeys, vanishedKeys };
}

function keyFrequencies(records: ReadonlyArray<Record<string, unknown>>): Record<string, number> {
  if (records.length === 0) return {};
  const counts: Record<string, number> = {};
  for (const rec of records) {
    for (const k of Object.keys(rec)) {
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  const freq: Record<string, number> = {};
  for (const [k, c] of Object.entries(counts)) freq[k] = c / records.length;
  return freq;
}
