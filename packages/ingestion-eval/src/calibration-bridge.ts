// Bridge from extraction scoring to the calibration package.
//
// toLabeledSamples flattens per-product ScoredFields into @aonex/calibration
// LabeledSamples, keeping only fields with a raw extractor confidence so the
// isotonic confidence map can be fit. Re-exported from the eval index.

import type { ScoredField } from "./types.js";
import type { LabeledSample } from "@aonex/calibration";

/** Convert scored fields into calibration training samples. Only fields whose
 *  extractor supplied a raw confidence can be used to fit the isotonic map. */
export function toLabeledSamples(perProduct: ScoredField[][]): LabeledSample[] {
  const out: LabeledSample[] = [];
  for (const scored of perProduct) {
    for (const s of scored) {
      if (typeof s.rawConfidence === "number") {
        out.push({ rawConfidence: s.rawConfidence, outcome: s.correct ? 1 : 0 });
      }
    }
  }
  return out;
}
