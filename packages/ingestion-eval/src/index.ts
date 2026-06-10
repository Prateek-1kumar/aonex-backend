// Public surface of @aonex/ingestion-eval, the offline extraction-eval harness.
//
// Re-exports scoring (scoreProduct/aggregate), field matching, the promote gate,
// golden-set loading, calibration bridging, and identity/ER merge metrics for
// the CLI and other packages.

export const EVAL_PACKAGE = "@aonex/ingestion-eval";
export * from "./types.js";
export { fieldWeight, CRITICAL_FIELDS } from "./field-weights.js";
export { fieldsMatch } from "./normalize.js";
export { scoreProduct, aggregate } from "./score-extraction.js";
export {
  scoreClassification,
  aggregateClassification,
  type ClassRow,
  type ClassAgg,
} from "./score-taxonomy.js";
export { promoteMetrics, type PromoteMetrics } from "./promote-metrics.js";
export { loadGoldenSet, splitBy } from "./golden-set.js";
export { toLabeledSamples } from "./calibration-bridge.js";
export { evaluateGate, DEFAULT_THRESHOLDS, type GateInput, type GateResult } from "./gate.js";
export {
  wouldAutoMerge,
  mergeMetrics,
  loadIdentityPairs,
  type IdentityPair,
  type MergeMetrics,
} from "./merge-pairs.js";
export {
  stubEmbedding,
  wouldErAutoMerge,
  erMetrics,
  defaultPairToSides,
  ER_PRECISION_BAR,
  ER_RECALL_BAR,
  ER_MERGE_THRESHOLD,
  type ErEvalSide,
  type ErMetrics,
} from "./er-eval.js";
