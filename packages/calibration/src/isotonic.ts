/**
 * Spec §14.3 — per-(extractor × category × source-type) confidence calibrator.
 *
 * Isotonic regression fits a monotone non-decreasing step function such that
 * f(raw_confidence) ≈ empirical accuracy on a held-out golden set.
 *
 * Algorithm: Pool Adjacent Violators (PAVA). O(n log n) due to the sort;
 * O(n) for the pooling pass. Used at fit time only — apply is O(log n) lookup.
 */

export interface LabeledSample {
  /** Raw confidence from the extractor (0..1). */
  rawConfidence: number;
  /** Empirical outcome: 1 = correct, 0 = wrong (reviewer-validated). */
  outcome: 0 | 1;
}

export interface IsotonicModel {
  /** Sorted breakpoints: raw confidence thresholds at which calibrated value changes. */
  thresholds: number[];
  /** Calibrated values aligned with `thresholds` (same length). */
  values: number[];
}

/**
 * Fit an isotonic regression to a set of (raw_confidence, outcome) samples.
 * Returns a step function model that maps raw confidence to calibrated accuracy.
 */
export function fitIsotonic(samples: LabeledSample[]): IsotonicModel {
  if (samples.length === 0) return { thresholds: [], values: [] };

  // Sort by raw confidence ascending; group equal-confidence samples.
  const sorted = [...samples].sort((a, b) => a.rawConfidence - b.rawConfidence);

  // Group identical x values to single point with weight = count, value = mean outcome.
  const groups: Array<{ x: number; y: number; w: number }> = [];
  for (const s of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.x === s.rawConfidence) {
      last.y = (last.y * last.w + s.outcome) / (last.w + 1);
      last.w += 1;
    } else {
      groups.push({ x: s.rawConfidence, y: s.outcome, w: 1 });
    }
  }

  // PAVA: walk left→right; when a violation (y[i] > y[i+1]) is detected,
  // pool the two into a weighted average and re-check left neighbor.
  const stack: Array<{ x: number; y: number; w: number }> = [];
  for (const g of groups) {
    stack.push({ ...g });
    while (stack.length >= 2) {
      const top = stack[stack.length - 1]!;
      const prev = stack[stack.length - 2]!;
      if (prev.y <= top.y) break;
      // Violation — pool the two.
      const pooledY = (prev.y * prev.w + top.y * top.w) / (prev.w + top.w);
      const pooledX = top.x;    // upper boundary of the merged block
      const pooledW = prev.w + top.w;
      stack.pop();
      stack.pop();
      stack.push({ x: pooledX, y: pooledY, w: pooledW });
    }
  }

  return {
    thresholds: stack.map((s) => s.x),
    values: stack.map((s) => s.y)
  };
}

/**
 * Apply a fitted isotonic model: returns the calibrated value for a given raw confidence.
 * Out-of-range inputs are clamped to the nearest endpoint.
 */
export function applyIsotonic(model: IsotonicModel, rawConfidence: number): number {
  if (model.thresholds.length === 0) return rawConfidence;    // identity when empty
  if (rawConfidence <= model.thresholds[0]!) return model.values[0]!;
  if (rawConfidence >= model.thresholds[model.thresholds.length - 1]!) {
    return model.values[model.values.length - 1]!;
  }
  // Find the smallest threshold >= rawConfidence (step function with right-closed intervals).
  for (let i = 0; i < model.thresholds.length; i++) {
    if (rawConfidence <= model.thresholds[i]!) return model.values[i]!;
  }
  // Shouldn't reach here given the bounds check above.
  return model.values[model.values.length - 1]!;
}
