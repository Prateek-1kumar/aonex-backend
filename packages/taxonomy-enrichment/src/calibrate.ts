// Confidence calibration.
//
// The model's self-reported confidence is, on its own, an unreliable signal —
// it is high on hallucinations and miscalibrated across field types. We fold it
// together with two signals the model does NOT control:
//   - grounding support (deterministic, from verify.ts)
//   - normalization status (from @aonex/taxonomy-validator: ok/coerced/invalid)
//
// Grounding is weighted ABOVE the self-report on purpose: a value the merchant's
// own data supports is worth more than a value the model merely feels sure about.
// The accept decision is then a single tunable threshold, so the eval can show
// the precision/recall trade-off explicitly.

import type { FieldStatus } from "@aonex/taxonomy-validator";
import type { Grounding } from "./types.js";

export interface CalibrationConfig {
  /** Weight on the model self-confidence. */
  wModel: number;
  /** Weight on the deterministic grounding support. */
  wGround: number;
  /** Minimum calibrated confidence to accept a field into the proposal. */
  acceptThreshold: number;
  /** Multiplier applied when the value needed normalization (coerced). */
  coercedPenalty: number;
  /** Hard ceiling for values the model flagged as inferred AND we found no support. */
  inferredCeiling: number;
  /** Auto-APPLY (not just propose) inferred world-knowledge values. Default false:
   *  ungrounded values are surfaced for human confirmation, never silently written
   *  to the catalog. The Lab confirmation then teaches the system (alias/learn loop). */
  acceptInferred: boolean;
}

export const DEFAULT_CALIBRATION: CalibrationConfig = {
  wModel: 0.4,
  wGround: 0.6,
  acceptThreshold: 0.5,
  coercedPenalty: 0.92,
  inferredCeiling: 0.6,
  acceptInferred: false,
};

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface CalibrationInput {
  modelConfidence: number;
  support: number;
  grounding: Grounding;
  status: FieldStatus;
}

export interface CalibrationOutput {
  calibratedConfidence: number;
  /** Auto-apply to the catalog: above threshold AND source-grounded (unless
   *  acceptInferred). The high-precision "never write an ungrounded fact" set. */
  accepted: boolean;
  /** Would-apply if a human confirms: above threshold, valid, not contradicted —
   *  includes confident inferences. The review/Lab queue + the upside number. */
  proposable: boolean;
}

const REJECT = (calibratedConfidence: number): CalibrationOutput => ({ calibratedConfidence, accepted: false, proposable: false });

export function calibrate(input: CalibrationInput, cfg: CalibrationConfig = DEFAULT_CALIBRATION): CalibrationOutput {
  const { modelConfidence, support, grounding, status } = input;

  // A field the model didn't produce, or that can't be made valid, can't be used.
  if (status === "missing") return REJECT(0);

  let c = cfg.wModel * clamp01(modelConfidence) + cfg.wGround * clamp01(support);

  if (status === "coerced") c *= cfg.coercedPenalty;

  // Invalid values are surfaced (flagged) but never applied or proposed.
  if (status === "invalid") return REJECT(round2(Math.min(c, 0.2)));

  // Contradictions are hallucinated overrides — hard reject.
  if (grounding === "contradicted") return REJECT(round2(Math.min(c, 0.1)));

  // Inferred (world-knowledge) values are kept but capped — they are not anchored
  // in the merchant's data, so they should not present as near-certain.
  if (grounding === "inferred") c = Math.min(c, cfg.inferredCeiling);

  const calibrated = round2(clamp01(c));
  const proposable = calibrated >= cfg.acceptThreshold;
  // Auto-apply only grounded values by default; inferred ones wait for a human.
  const accepted = proposable && (grounding !== "inferred" || cfg.acceptInferred);
  return { calibratedConfidence: calibrated, accepted, proposable };
}
