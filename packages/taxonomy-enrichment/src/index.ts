// @aonex/taxonomy-enrichment — grounded, node-schema-conditioned product
// enrichment. Fills a taxonomy leaf's attribute schema from the product's own
// data, normalizes via @aonex/taxonomy-validator, deterministically verifies
// grounding (not the model's self-score), and calibrates a final confidence.
//
// Pure + provider-injected: the caller supplies a ChatProvider (structurally
// compatible with @aonex/ingestion-llm-extractor's IModelProvider), the leaf
// schema, and a catalog-RAG corpus.

export const TAXONOMY_ENRICHMENT_PACKAGE = "@aonex/taxonomy-enrichment";

export { enrichProduct, toLeafSchema, acceptedAttributes, ENRICH_PROMPT_VERSION, CONTENT_PROMPT_VERSION, type EnrichDeps } from "./enrich.js";
export { buildEnrichmentPrompt, SYSTEM } from "./prompt.js";
export { buildContentPrompt, CONTENT_SYSTEM, type ContentPromptInput } from "./content-prompt.js";
export { validateContentField, meetsContentBar, type ContentOutcome } from "./content-validate.js";
export { scoreContent } from "./content-score.js";
export { parseEnrichmentResponse, EnrichmentParseError, type ParsedEnrichment } from "./parse.js";
export { retrieveExamples, departmentOf, type RetrieveQuery, type RetrieveOptions } from "./rag.js";
export { verifyField, verifyContentField, buildVerifyContext, type VerifyContext } from "./verify.js";
export { calibrate, calibrateContent, CONTENT_PROPOSE_THRESHOLD, DEFAULT_CALIBRATION, type CalibrationConfig, type CalibrationInput, type CalibrationOutput } from "./calibrate.js";
export {
  normalizeText, tokens, tokenSet, numerals, jaccard, valueToText,
} from "./text.js";
export { isContentField } from "./types.js";
export type {
  EnrichField,
  FieldKind,
  ContentType,
  ContentConstraints,
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
