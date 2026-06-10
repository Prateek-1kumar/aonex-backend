// @aonex/taxonomy-enrichment — grounded, node-schema-conditioned product
// enrichment. Fills a taxonomy leaf's attribute schema from the product's own
// data, normalizes via @aonex/taxonomy-validator, deterministically verifies
// grounding (not the model's self-score), and calibrates a final confidence.
//
// Pure + provider-injected: the caller supplies a ChatProvider (structurally
// compatible with @aonex/ingestion-llm-extractor's IModelProvider), the leaf
// schema, and a catalog-RAG corpus.

export const TAXONOMY_ENRICHMENT_PACKAGE = "@aonex/taxonomy-enrichment";

export { enrichProduct, toLeafSchema, acceptedAttributes, ENRICH_PROMPT_VERSION, type EnrichDeps } from "./enrich.js";
export { buildEnrichmentPrompt, SYSTEM } from "./prompt.js";
export { parseEnrichmentResponse, EnrichmentParseError, type ParsedEnrichment } from "./parse.js";
export { retrieveExamples, departmentOf, type RetrieveQuery, type RetrieveOptions } from "./rag.js";
export { verifyField, buildVerifyContext, type VerifyContext } from "./verify.js";
export { calibrate, DEFAULT_CALIBRATION, type CalibrationConfig, type CalibrationInput, type CalibrationOutput } from "./calibrate.js";
export {
  normalizeText, tokens, tokenSet, numerals, jaccard, valueToText,
} from "./text.js";
export type {
  EnrichField,
  SourceProduct,
  RagExample,
  CatalogEntry,
  EnrichmentInput,
  FieldGeneration,
  CandidateAttribute,
  Grounding,
  GroundingVerdict,
  FieldAction,
  FieldResult,
  EnrichmentResult,
  ChatProvider,
  AttrDataType,
  FieldStatus,
  Tier,
  Completeness,
} from "./types.js";
