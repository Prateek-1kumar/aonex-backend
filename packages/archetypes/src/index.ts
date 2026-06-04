// Public surface of @aonex/archetypes, the product category-family classifier.
//
// Re-exports the archetype registry, classifyArchetype, completeness scoring
// (scoreCompleteness/hardFloorOk), and the per-vertical enablement flag. The
// ingestion eval and pipeline consume these to gate required-attribute coverage.

export const ARCHETYPES_PACKAGE = "@aonex/archetypes";
export * from "./types.js";
export { registerArchetype, getArchetype, listArchetypes } from "./registry.js";
export { classifyArchetype, type ClassifySignals } from "./classify.js";
export { scoreCompleteness, hardFloorOk, type ScoreOptions } from "./completeness.js";
export { archetypeEnabledFor } from "./flag.js";
