// HLD §10 — Semantic Mapper public API.
export * from "./types.js";
export { map, MAPPER_VERSION } from "./map.js";
export { MAPPING_WEIGHTS, computeScore, resolveApproval } from "./pipeline/scorer.js";
