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
