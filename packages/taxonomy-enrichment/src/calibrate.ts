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
  /** Hard ceiling for DECLARED world-knowledge inferences (no source support). */
  inferredCeiling: number;
  /** Hard ceiling for UNVERIFIED values (no support, no declared basis). Set below
   *  acceptThreshold so an unanchored fabrication is never proposable, let alone
   *  applied — it is persisted only so the UI can show it as "speculative". */
  unverifiedCeiling: number;
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
  unverifiedCeiling: 0.3,
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

/** Lower bar to SURFACE a content field for review (vs the spec accept bar). Content
 *  never auto-applies, so the only question is "is it worth showing the reviewer?". */
export const CONTENT_PROPOSE_THRESHOLD = 0.3;

/** Calibrate a SYNTHESIZED content field. Unlike specs, content is NEVER
 *  auto-applied (accepted is always false) — it flows through the drafting room
 *  for human review. We still reject contradictions and invalid shapes, and we
 *  surface everything else above a low bar so the reviewer can edit/keep/drop it. */
export function calibrateContent(input: CalibrationInput, cfg: CalibrationConfig = DEFAULT_CALIBRATION): CalibrationOutput {
  const { modelConfidence, support, grounding, status } = input;
  if (status === "missing") return REJECT(0);

  let c = cfg.wModel * clamp01(modelConfidence) + cfg.wGround * clamp01(support);
  if (status === "coerced") c *= cfg.coercedPenalty;
  if (status === "invalid") return REJECT(round2(Math.min(c, 0.2)));
  // Contradicts a confirmed attribute — wrong, drop it (don't even show).
  if (grounding === "contradicted") return REJECT(round2(Math.min(c, 0.1)));
  // Unanchored content (should it ever be labelled unverified) is capped low.
  if (grounding === "unverified") c = Math.min(c, cfg.unverifiedCeiling);

  const calibrated = round2(clamp01(c));
  return { calibratedConfidence: calibrated, accepted: false, proposable: calibrated >= CONTENT_PROPOSE_THRESHOLD };
}

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

  // Inferred (declared world-knowledge) values are kept but capped — they are not
  // anchored in the merchant's data, so they should not present as near-certain.
  if (grounding === "inferred") c = Math.min(c, cfg.inferredCeiling);

  // Unverified (unanchored, no declared basis) values are capped below the accept
  // bar, so they fall out of both `proposable` and `accepted` automatically.
  if (grounding === "unverified") c = Math.min(c, cfg.unverifiedCeiling);

  const calibrated = round2(clamp01(c));
  const proposable = calibrated >= cfg.acceptThreshold;
  // Auto-apply only grounded values by default; inferred ones wait for a human.
  const accepted = proposable && (grounding !== "inferred" || cfg.acceptInferred);
  return { calibratedConfidence: calibrated, accepted, proposable };
}
