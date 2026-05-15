// LLM Extractor types — pure data shapes for LLM-based product extraction.
// These types bridge the LLM output to the existing ExtractedFact/ExtractedFactSet
// contract from @aonex/ingestion-field-extractor.

import type { ExtractedFact, ExtractedFactSet } from "@aonex/ingestion-field-extractor";

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
  title?: string;
  brand?: string;
  gtin?: string;
  model_number?: string;
  description?: string;
  base_price?: number;
  currency?: string;
  category_path?: string;
  category_confidence?: number;
  images?: Array<{ url: string; alt_text?: string }>;
  attributes?: Record<string, unknown>;
  variants?: Array<{
    sku?: string;
    barcode?: string;
    price?: number;
    option_values?: Record<string, string>;
    inventory_quantity?: number;
  }>;
  _field_confidence?: Record<string, number>;
}

/** Extractor version identifier — bump when prompt or parsing logic changes. */
export const LLM_EXTRACTOR_VERSION = "llm-url@1.0.0";

export const DEFAULT_LLM_OPTIONS: Required<LLMExtractionOptions> = {
  model: process.env.OPENAI_MODEL || "gpt-4o-mini",
  maxTokens: 4096,
  temperature: 0.1,
  categoryHint: "",
};

export interface LLMGapFillOptions extends LLMExtractionOptions {
  /** The rawKeys that are missing and need to be filled by the LLM. */
  gaps: string[];
  /** Already-extracted structured facts to anchor the LLM on. */
  structuredFacts: { rawKey: string; value: unknown; source: string }[];
  /** Optional category candidates for prompting context. */
  categoryCandidates?: string[];
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
}
