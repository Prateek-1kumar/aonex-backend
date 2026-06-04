// Public API of @aonex/multi-source-reconciler.
//
// Re-exports the identity scorer (computeMatchScore/WEIGHTS/THRESHOLDS), the
// field-merge + action policy (reconcileFields/decideReconciliationAction), and
// the blocking/pair-feature helpers. Consumed by the catalog identity-resolver
// and write path to dedupe and merge cross-source observations.

export { jaroWinkler } from "./jaro-winkler.js";
export {
  computeMatchScore,
  type ProductIdentity,
  type MatchScoreBreakdown,
  WEIGHTS,
  THRESHOLDS
} from "./scoring.js";
export {
  reconcileFields,
  decideReconciliationAction,
  type Field,
  type ReconciliationAction,
  type ReconciliationDecision
} from "./policy.js";
export { blockingKeys, type BlockingSignals } from "./blocking.js";
export { scorePair, type PairSide, type PairScore } from "./pair-features.js";
