export const EVAL_PACKAGE = "@aonex/ingestion-eval";
export * from "./types.js";
export { fieldWeight, CRITICAL_FIELDS } from "./field-weights.js";
export { fieldsMatch } from "./normalize.js";
export { scoreProduct, aggregate } from "./score-extraction.js";
export { promoteMetrics, type PromoteMetrics } from "./promote-metrics.js";
export { loadGoldenSet, splitBy } from "./golden-set.js";
export { toLabeledSamples } from "./calibration-bridge.js";
export { evaluateGate, DEFAULT_THRESHOLDS, type GateInput, type GateResult } from "./gate.js";
