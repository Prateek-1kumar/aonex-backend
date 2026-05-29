// Phase 3 Task 3: replace raw model confidence with empirically-calibrated
// accuracy from the fitted isotonic map (spec D1 — no more arbitrary 0.7s).

import { applyIsotonic, type IsotonicModel } from "@aonex/calibration";

export interface RawFact {
  field: string;
  value: unknown;
  rawConfidence: number;
}

export interface CalibratedFact {
  field: string;
  value: unknown;
  confidence: number;
}

/** Apply the fitted isotonic model to each fact's raw confidence. */
export function calibrateFacts(facts: RawFact[], model: IsotonicModel): CalibratedFact[] {
  return facts.map((f) => ({
    field: f.field,
    value: f.value,
    confidence: applyIsotonic(model, f.rawConfidence),
  }));
}
