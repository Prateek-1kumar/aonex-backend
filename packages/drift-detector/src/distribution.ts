/**
 * Spec §14.6 — distribution drift via Population Stability Index (PSI).
 *
 * PSI < 0.10: no significant change
 * 0.10 ≤ PSI < 0.25: moderate (investigate)
 * PSI ≥ 0.25: significant (act)
 *
 * Discretize numeric values into bins; for categorical values, each distinct
 * value is its own bin. Add a small epsilon to zero-count bins to avoid
 * log(0) (industry-standard smoothing).
 */

export interface PSIResult {
  /** Per-bin PSI contribution */
  bins: Array<{ label: string; baselineFraction: number; currentFraction: number; contribution: number }>;
  /** Sum of contributions */
  psi: number;
}

export interface DistributionDriftReport {
  field: string;
  psi: number;
  category: "no_drift" | "moderate" | "significant";
}

const EPS = 1e-4;
const MODERATE_THRESHOLD = 0.10;
const SIGNIFICANT_THRESHOLD = 0.25;

/**
 * Compute PSI given pre-computed bin counts for baseline and current cohorts.
 * Bins keyed by label; missing keys treated as 0 count.
 */
export function computePSI(
  baselineCounts: Record<string, number>,
  currentCounts: Record<string, number>
): PSIResult {
  const baselineTotal = Object.values(baselineCounts).reduce((a, b) => a + b, 0);
  const currentTotal = Object.values(currentCounts).reduce((a, b) => a + b, 0);
  const labels = new Set([...Object.keys(baselineCounts), ...Object.keys(currentCounts)]);

  if (baselineTotal === 0 || currentTotal === 0) {
    return { bins: [], psi: 0 };
  }

  let psi = 0;
  const bins: PSIResult["bins"] = [];
  for (const label of labels) {
    const baselineFraction = Math.max((baselineCounts[label] ?? 0) / baselineTotal, EPS);
    const currentFraction = Math.max((currentCounts[label] ?? 0) / currentTotal, EPS);
    const contribution = (currentFraction - baselineFraction) * Math.log(currentFraction / baselineFraction);
    bins.push({ label, baselineFraction, currentFraction, contribution });
    psi += contribution;
  }

  return { bins, psi };
}

/**
 * Detect distribution drift for a single field by comparing baseline and
 * current value distributions. Discretization is caller's responsibility
 * (for numeric values, pre-bucket into ranges; for categoricals, use value as label).
 */
export function detectDistributionDrift(
  field: string,
  baselineCounts: Record<string, number>,
  currentCounts: Record<string, number>
): DistributionDriftReport {
  const { psi } = computePSI(baselineCounts, currentCounts);
  let category: DistributionDriftReport["category"];
  if (psi < MODERATE_THRESHOLD) category = "no_drift";
  else if (psi < SIGNIFICANT_THRESHOLD) category = "moderate";
  else category = "significant";
  return { field, psi, category };
}
