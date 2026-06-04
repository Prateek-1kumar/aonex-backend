// Public surface of `@aonex/calibration` — confidence calibration (Spec §14.3/§14.4).
//
// Re-exports the isotonic-regression calibrator (fitIsotonic via PAVA /
// applyIsotonic; raw confidence → calibrated accuracy) and the Beta-Binomial
// reliability prior (betaBinomialPosterior / updatePrior) used to track
// per-domain × field reliability from reviewer corrections.

export {
  fitIsotonic,
  applyIsotonic,
  type IsotonicModel,
  type LabeledSample
} from "./isotonic.js";
export {
  betaBinomialPosterior,
  updatePrior,
  type ReliabilityPrior
} from "./beta-binomial.js";
