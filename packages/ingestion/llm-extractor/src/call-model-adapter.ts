// Phase 3 Task 6: adapter exposing extractGapFill as a callModel-shaped function
// for genericExtract. Captures structured hints + baseFacts once, then returns a
// function that takes (schemaFields, cleanedText) and asks the LLM only for those
// fields, with the captured hints as context. Mirrors @aonex/vision-extractor's
// createVisionCallModel pattern.

import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { LLMProductExtractor } from "./extractor.js";
import type { StructuredHints } from "./types.js";

export interface CreateLlmCallModelInput {
  llmExtractor: LLMProductExtractor;
  baseFacts: ExtractedFact[];
  structuredHints: StructuredHints;
  finalUrl: string;
  artifactId: string;
  onCost?: (usd: number) => void;
}

/** Returns a callModel-shaped function. cleanedText is the page text; schemaFields
 *  is the list of fields genericExtract decided need filling. */
export function createLlmCallModel(
  input: CreateLlmCallModelInput
): (
  schemaFields: string[],
  cleanedText: string
) => Promise<Record<string, { value: unknown; rawConfidence: number }>> {
  return async (schemaFields, cleanedText) => {
    if (schemaFields.length === 0) return {};
    const r = await input.llmExtractor.extractGapFill(
      cleanedText,
      input.finalUrl,
      input.artifactId as never,
      {
        gaps: [...schemaFields],
        structuredFacts: input.baseFacts.map((f) => ({
          rawKey: f.rawKey,
          value: f.normalizedValue ?? f.extractedValue,
          source: f.extractionMethod ?? "structured",
        })),
        structuredHints: input.structuredHints,
      }
    );
    if (input.onCost && typeof r.estimatedCostUsd === "number") {
      input.onCost(r.estimatedCostUsd);
    }
    const out: Record<string, { value: unknown; rawConfidence: number }> = {};
    for (const fact of r.facts) {
      out[fact.rawKey] = {
        value: fact.normalizedValue ?? fact.extractedValue,
        rawConfidence: fact.confidence,
      };
    }
    return out;
  };
}
