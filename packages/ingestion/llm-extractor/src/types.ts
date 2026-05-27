// LLM Extractor types — pure data shapes for LLM-based product extraction.
// These types bridge the LLM output to the existing ExtractedFact/ExtractedFactSet
// contract from @aonex/ingestion-field-extractor.

import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

/** Configuration for the LLM extraction. */
export interface LLMExtractionOptions {
  /** Model identifier to use (e.g. "gpt-4o-mini", "gpt-4o"). */
  model?: string;
  /** Maximum tokens for the completion. Default 4096. */
  maxTokens?: number;
  /** Temperature for generation. Default 0.1 (near-deterministic). */
  temperature?: number;
  /** Category hint provided by the user or auto-detected. */
  categoryHint?: string;
  /** Phase 1 (richness plan): structured hints from the fetcher (JSON-LD, meta tags, etc). */
  structuredHints?: StructuredHints;
}

/** Result from the LLM extraction process. */
export interface LLMExtractionResult {
  /** Extracted facts in the same shape as field-extractor output. */
  facts: ExtractedFact[];
  /** Best-guess canonical category path (e.g. "electronics/televisions"). */
  suggestedCategory: string | null;
  /** Confidence in the category assignment (0..1). */
  categoryConfidence: number;
  /** Which model was used. */
  modelName: string;
  /** Model version/snapshot ID. */
  modelVersion: string;
  /** Prompt tokens consumed. */
  promptTokens: number;
  /** Completion tokens consumed. */
  completionTokens: number;
  /** Estimated cost in USD for this extraction call. */
  estimatedCostUsd: number;
}

/** Shape of the JSON the LLM should return (before validation). */
export interface LLMRawProductOutput {
  // Identity
  title?: string | null;
  brand?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  model_number?: string | null;
  sku?: string | null;

  // Descriptions
  description?: string | null;             // legacy — keep for back-compat
  description_short?: string | null;
  description_long?: string | null;
  highlights?: string[];

  // Taxonomy
  category_path?: string | null;
  category_confidence?: number;
  breadcrumbs?: string[];

  // Pricing (legacy base_price kept for back-compat with old prompts)
  base_price?: number | null;
  currency?: string | null;
  pricing?: {
    list_price?: number | null;
    sale_price?: number | null;
    currency?: string | null;
    discount_percent?: number | null;
    price_per_unit?: string | null;
  };

  // Social proof
  ratings?: { average?: number | null; count?: number | null };
  seller?: { name?: string | null; is_official?: boolean | null };

  // Images (richer)
  images?: Array<{
    url: string;
    role?: "hero" | "gallery" | "swatch" | "lifestyle" | "spec" | "video_thumb";
    position?: number;
    alt_text?: string | null;
    width?: number | null;
    height?: number | null;
    variant_refs?: string[];
  }>;

  options?: Array<{ name: string; values: string[] }>;

  // Variants
  variants?: Array<{
    sku?: string | null;
    barcode?: string | null;
    option_values?: Record<string, string>;
    pricing?: { list_price?: number | null; sale_price?: number | null; currency?: string | null };
    image_urls?: string[];
    // legacy fields kept:
    price?: number | null;
    inventory_quantity?: number | null;
  }>;

  // Category-specific attributes
  attributes?: Record<string, { value: unknown; unit?: string | null; source?: string } | unknown>;

  // Logistics
  shipping?: {
    free_shipping?: boolean | null;
    shipping_cost?: number | null;
    weight?: { value: number; unit: string } | null;
    dimensions?: { length: number; width: number; height: number; unit: string } | null;
  };
  warranty?: string | null;
  return_policy?: string | null;

  // Meta
  _field_confidence?: Record<string, number>;
  _correction_notes?: Record<string, string>;
  error?: string | null;
}

/** Extractor version identifier — bump when prompt or parsing logic changes. */
export const LLM_EXTRACTOR_VERSION = "llm-url@1.0.0";

export const DEFAULT_LLM_OPTIONS: Required<LLMExtractionOptions> = {
  // Phase 6: prefer Groq models when available. GROQ_MODEL_GAP_FILL_HEAVY
  // (heavy analysis), then GROQ_MODEL_GAP_FILL, then OPENAI_MODEL, then
  // Groq's llama-3.3-70b-versatile as the final default (paired with
  // OPENAI_BASE_URL pointing to Groq in .env).
  model:
    process.env["GROQ_MODEL_GAP_FILL_HEAVY"] ||
    process.env["GROQ_MODEL_GAP_FILL"] ||
    process.env["OPENAI_MODEL"] ||
    "llama-3.3-70b-versatile",
  maxTokens: 4096,
  temperature: 0.1,
  categoryHint: "",
  structuredHints: {},
};

/**
 * Phase 6: cheaper classifier model used by category-detection code paths
 * (NOT product extraction). Defaults to llama-3.1-8b-instant on Groq;
 * fall back to gpt-4o-mini if Groq is not configured.
 */
export const DEFAULT_CLASSIFIER_MODEL =
  process.env["GROQ_MODEL_CLASSIFIER"] || process.env["OPENAI_CLASSIFIER_MODEL"] || "gpt-4o-mini";

export interface LLMGapFillOptions extends LLMExtractionOptions {
  /** The rawKeys that are missing and need to be filled by the LLM. */
  gaps: string[];
  /** Already-extracted structured facts to anchor the LLM on. */
  structuredFacts: { rawKey: string; value: unknown; source: string }[];
  /** Optional category candidates for prompting context. */
  categoryCandidates?: string[];
}

export interface StructuredHints {
  jsonLd?: Record<string, unknown>[];
  metaTags?: Record<string, string>;
  microdata?: { prop: string; value: string }[];
  rawImageUrls?: string[];
  nextDataProductSubtree?: unknown;
}

export interface PromptBuildParams {
  cleanedText: string;
  url: string;
  /** Pre-extracted facts to anchor the LLM on. LLM must not override these unless flagged. */
  structuredFacts?: { rawKey: string; value: unknown; source: string }[];
  /** When set, LLM fills ONLY these field rawKeys. */
  gaps?: string[];
  /** Categories from category_schemas (replaces hardcoded LAUNCH_CATEGORIES). */
  categoryCandidates?: string[];
  /** Category-required attributes for the (suspected) category, for prompting context. */
  categoryRequiredAttributes?: string[];
  categoryHint?: string;
  structuredHints?: StructuredHints;
}
