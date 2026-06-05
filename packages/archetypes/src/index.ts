// Public surface of @aonex/archetypes, the product category-family classifier.
//
// Re-exports the archetype registry, classifyArchetype, completeness scoring
// (scoreCompleteness/hardFloorOk), and the per-vertical enablement flag. The
// ingestion eval and pipeline consume these to gate required-attribute coverage.

export const ARCHETYPES_PACKAGE = "@aonex/archetypes";
export * from "./types.js";
export { registerArchetype, getArchetype, listArchetypes } from "./registry.js";
export { classifyArchetype, type ClassifySignals } from "./classify.js";
export {
  scoreCompleteness, hardFloorOk, type ScoreOptions,
  scoreCompletenessPercent, type CompletenessPercent, type TierCoverage,
} from "./completeness.js";
export { archetypeEnabledFor } from "./flag.js";

// Catalog enrichment — dynamic schema resolver + typed attribute catalogue.
export {
  resolveActiveSchema,
  type ActiveSchema, type ResolvedField, type ResolveOptions,
} from "./schema.js";
export {
  type AttrDef, type AttrDataType, type EnrichmentGroup,
  PROTECTED_KEYS, UNIVERSAL_ATTRS, ARCHETYPE_DESCRIPTIVE,
  allAttrDefs, lookupAttrDef,
} from "./seed/attribute-catalog.js";
