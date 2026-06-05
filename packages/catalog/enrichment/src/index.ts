// Public API for @aonex/catalog-enrichment — the LLM enrichment engine.
export const CATALOG_ENRICHMENT_PACKAGE = "@aonex/catalog-enrichment";

export { generateEnrichmentProposal, type EnrichDeps } from "./enrich.js";
export { buildEnrichmentPrompt, ENRICH_PROMPT_VERSION } from "./prompt.js";
export { parseEnrichmentResponse, EnrichmentParseError, type ParsedEnrichment } from "./parse.js";
export { buildProposal, type BuildProposalArgs } from "./proposal.js";
export type {
  ProductSnapshot,
  EnrichmentProposal,
  ProposalField,
  CandidateAttribute,
  ScoreSnapshot,
  FieldAction,
  FieldDecision,
  CandidateDecision,
} from "./types.js";
