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
