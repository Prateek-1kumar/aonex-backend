export const ARCHETYPES_PACKAGE = "@aonex/archetypes";
export * from "./types.js";
export { registerArchetype, getArchetype, listArchetypes } from "./registry.js";
export { classifyArchetype, type ClassifySignals } from "./classify.js";
export { scoreCompleteness, hardFloorOk, type ScoreOptions } from "./completeness.js";
export { archetypeEnabledFor } from "./flag.js";
