// @aonex/taxonomy-enrichment — contracts.
//
// Grounded enrichment fills a taxonomy LEAF's attribute schema (node_attributes)
// from the product's own data, normalizes through @aonex/taxonomy-validator,
// then DETERMINISTICALLY verifies each value is grounded in the source (not the
// model's self-confidence), and calibrates a final confidence. Nothing here is
// written to the catalog — the caller turns accepted fields into observations.

import type { AttrDataType, Completeness, FieldStatus, Tier } from "@aonex/taxonomy-validator";

export type { AttrDataType, FieldStatus, Tier } from "@aonex/taxonomy-validator";

/** A field's role in enrichment:
 *  - "spec":    a structured, typed attribute (fit/fabric/storage). EXTRACTED from
 *               the source and verified against it (substring/token grounding).
 *  - "content": synthesized listing copy (description/SEO/marketing/AEO). COMPOSED
 *               from already-confirmed facts; grounded compositionally (no new facts). */
export type FieldKind = "spec" | "content";

/** Shape of a synthesized content field (drives the content prompt + validator). */
export type ContentType =
  | "text" // a single string body (meta_title, description_long, aeo_summary)
  | "string_list" // an array of short strings (key_features, seo_keywords, tags)
  | "qa_list" // an array of { q, a } (faq)
  | "pros_cons"; // a { pros: string[], cons: string[] } object

/** Length / count limits for a content field (chars for text, items for lists). */
export interface ContentConstraints {
  /** Max characters for a `text` field or per item of a list. */
  maxLen?: number;
  /** Min / max number of items for a list field. */
  minItems?: number;
  maxItems?: number;
}

/** One attribute the engine should try to fill. Superset of the validator's
 *  AttributeSpec with the prompt-facing label/description/group. Built by the
 *  caller from node_attributes ⨝ attribute_definitions (specs) and the universal
 *  CONTENT_ATTRIBUTES (content). */
export interface EnrichField {
  key: string;
  tier: Tier;
  label?: string;
  description?: string;
  dataType?: AttrDataType;
  enumValues?: string[];
  unit?: string;
  allowedUnits?: string[];
  min?: number;
  max?: number;
  /** Variant-defining axis (size/color) — surfaced to the prompt as important. */
  isVariantAxis?: boolean;
  /** Enrichment group (attribute_definitions.enrichment_group): "descriptive" for
   *  specs; "content"/"marketing"/"seo"/"aeo" for the universal content layer. */
  group?: string;
  /** "spec" (default) vs "content". Routes the field to the right stage/verifier. */
  kind?: FieldKind;
  /** Content-only: the synthesized value's shape. */
  contentType?: ContentType;
  /** Content-only: length / count limits. */
  constraints?: ContentConstraints;
  /** Content-only: weight within the content-quality rubric. */
  weight?: number;
}

/** A content field is one synthesized from confirmed facts, not extracted. */
export const isContentField = (f: { kind?: FieldKind }): boolean => f.kind === "content";

/** The product's own data — the grounding corpus + the diff baseline. */
export interface SourceProduct {
  title?: string;
  brand?: string;
  description?: string;
  /** Source/marketplace category breadcrumb (a strong gender/use signal). */
  sourceCategory?: string;
  /** Already-known attribute values (key -> value); used for the diff + contradiction checks. */
  knownAttrs?: Record<string, unknown>;
  /** Any extra free text (bullet points, spec blob) to ground against. */
  extraText?: string;
}

/** A similar product retrieved from the catalog (catalog-RAG few-shot). */
export interface RagExample {
  title: string;
  brand?: string;
  /** Confirmed/normalized attributes of the similar product. */
  attrs: Record<string, unknown>;
  /** Provenance for logging only. */
  nodeId?: string;
}

/** A catalog row the RAG retriever ranks over. */
export interface CatalogEntry {
  title: string;
  brand?: string;
  nodeId?: string;
  /** node department prefix (first path segment) — precomputed or derived. */
  departmentId?: string;
  attrs: Record<string, unknown>;
}

export interface EnrichmentInput {
  nodeId: string;
  /** Display breadcrumb for prompt context, e.g. "Electronics › Mobiles › Mobile Phones". */
  nodePath?: string;
  schema: EnrichField[];
  product: SourceProduct;
  examples?: RagExample[];
}

// ── Model generation (parsed, untrusted) ─────────────────────────────────────

export interface FieldGeneration {
  key: string;
  value: unknown;
  /** Model self-reported confidence 0..1 (NOT trusted as-is — calibrated later). */
  confidence: number;
  /** Source span the model claims to have grounded on (verified independently). */
  evidence?: string;
  /** Model's own claim that it inferred (vs read) the value. A hint, not the verdict. */
  inferred?: boolean;
  reasoning?: string;
}

/** A type-relevant attribute the model surfaced that is NOT in the leaf schema. */
export interface CandidateAttribute {
  key: string;
  label?: string;
  dataType?: AttrDataType;
  value: unknown;
  unit?: string;
  reasoning?: string;
}

// ── Verification + final per-field result ────────────────────────────────────

/** How well a generated value is supported by the product's OWN data.
 *  - grounded:     value (or its evidence span) is present in the source text.
 *  - weak:         partial / fuzzy support only.
 *  - inferred:     plausible world-knowledge derivation the model DECLARED (set
 *                  inferred + reasoning), e.g. "iPhone 15" -> os: iOS. No source
 *                  support, kept but capped.
 *  - unverified:   a value emitted as if read, into an attribute the source never
 *                  mentions, with no declared basis — an unanchored fabrication.
 *                  Capped so low it is neither auto-applied nor surfaced for review.
 *  - contradicted: conflicts with an explicit known source value. */
export type Grounding = "grounded" | "weak" | "inferred" | "unverified" | "contradicted";

export interface GroundingVerdict {
  grounding: Grounding;
  /** Deterministic support signal 0..1. */
  support: number;
  detail?: string;
}

export type FieldAction = "fill" | "improve";

export interface FieldResult {
  key: string;
  tier: Tier;
  /** "spec" (extracted) vs "content" (synthesized) — routes display + apply. */
  kind?: FieldKind;
  /** Enrichment group (seo/marketing/aeo/content for content; descriptive for specs). */
  group?: string;
  /** Content shape — set for content fields so the drafting room can render it. */
  contentType?: ContentType;
  /** Raw model value. */
  raw: unknown;
  /** Validator-normalized value (when ok/coerced). */
  normalized?: unknown;
  status: FieldStatus;
  grounding: Grounding;
  /** Deterministic grounding support 0..1. */
  support: number;
  modelConfidence: number;
  /** Final calibrated confidence 0..1 (model × grounding × normalization). */
  calibratedConfidence: number;
  /** Auto-applied to the catalog: valid, source-grounded, above threshold. */
  accepted: boolean;
  /** Would-apply pending human confirmation: valid, not contradicted, above
   *  threshold — includes confident inferences (superset of `accepted`). */
  proposable: boolean;
  action: FieldAction;
  evidence?: string;
  reasoning?: string;
  message?: string;
}

export interface EnrichmentResult {
  nodeId: string;
  fields: FieldResult[];
  candidates: CandidateAttribute[];
  /** Completeness of the KNOWN input attrs vs schema (the "before" number). */
  completenessBefore: Completeness;
  /** Completeness of the AUTO-APPLIED (grounded) enriched attrs (the trustworthy "after"). */
  completenessAfter: Completeness;
  /** Completeness if the inferred PROPOSALS are also confirmed (the review-upside ceiling). */
  completenessProposed: Completeness;
  /** Content quality of the content already on the product (the "before"). */
  contentQualityBefore: Completeness;
  /** Content quality if the proposed content is committed (the review-upside). */
  contentQualityProposed: Completeness;
  /** Fraction of accepted (auto-applied) fields that are source-grounded. */
  groundingRate: number;
  /** Fraction of proposable content fields that are grounded/weak (not generic-inferred). */
  contentGroundingRate: number;
  /** Count of proposable-but-inferred fields awaiting human confirmation. */
  proposedInferred: number;
  /** Count of unverified (unanchored, no-declared-basis) spec fields. Suppressed
   *  from auto-apply AND review; surfaced only as "speculative" for transparency. */
  unverifiedCount: number;
  model?: string;
  usage?: { promptTokens: number; completionTokens: number };
  costUsd?: number;
  /** Set when the model call/parse failed and the result is empty. */
  error?: string;
}

export type { Completeness } from "@aonex/taxonomy-validator";

// ── Provider injection (structurally compatible with IModelProvider) ─────────

export type { ChatProvider } from "@aonex/lib-utils";
