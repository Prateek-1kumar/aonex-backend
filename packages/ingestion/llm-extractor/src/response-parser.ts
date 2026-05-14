// Response parser — validates the LLM JSON output and converts it
// into the ExtractedFact[] shape that plugs into the existing
// semantic mapper pipeline.
//
// HLD §22.3: "Validate all model output against JSON Schema."
// We use Zod for runtime validation of the LLM's structured output.

import { z } from "zod";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { LLMRawProductOutput } from "./types.js";

/** Zod schema for validating the LLM's JSON response. */
const ImageSchema = z.object({
  url: z.string().url().optional().default(""),
  alt_text: z.string().nullable().optional().default(null),
});

const VariantSchema = z.object({
  sku: z.string().nullable().optional().default(null),
  barcode: z.string().nullable().optional().default(null),
  price: z.number().nullable().optional().default(null),
  option_values: z.record(z.string()).optional().default({}),
  inventory_quantity: z.number().int().nullable().optional().default(null),
});

const LLMOutputSchema = z.object({
  title: z.string().nullable().optional().default(null),
  brand: z.string().nullable().optional().default(null),
  gtin: z.string().nullable().optional().default(null),
  model_number: z.string().nullable().optional().default(null),
  description: z.string().nullable().optional().default(null),
  base_price: z.number().nullable().optional().default(null),
  currency: z.string().max(3).nullable().optional().default(null),
  category_path: z.string().nullable().optional().default(null),
  category_confidence: z.number().min(0).max(1).optional().default(0.5),
  images: z.array(ImageSchema).optional().default([]),
  attributes: z.record(z.unknown()).optional().default({}),
  variants: z.array(VariantSchema).optional().default([]),
  error: z.string().nullable().optional(),
  _field_confidence: z.record(z.number().min(0).max(1)).optional(),
});

/**
 * Parse and validate the raw LLM JSON string into a structured
 * product output. Returns null if the content is invalid JSON
 * or fails validation.
 */
export function parseLLMResponse(raw: string): LLMRawProductOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = LLMOutputSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  // If the LLM reported no product found
  if (result.data.error && !result.data.title) {
    return null;
  }

  return result.data as LLMRawProductOutput;
}

/**
 * Returns the LLM self-reported confidence for a field, capped at 0.85 (HLD §14.2).
 * Falls back to 0.5 when the field is absent from _field_confidence.
 */
function confidenceFor(key: string, out: LLMRawProductOutput): number {
  const fc = (out as { _field_confidence?: Record<string, number> })._field_confidence;
  const v = fc?.[key];
  return Math.min(0.85, typeof v === "number" ? v : 0.5);
}

/**
 * Convert the validated LLM output into ExtractedFact[] compatible
 * with the existing field-extractor and semantic-mapper pipeline.
 *
 * Each fact carries:
 *   - rawKey: the field name from the LLM output
 *   - extractedValue / normalizedValue: the raw and cleaned values
 *   - sourcePointer: description of where the LLM found this
 *   - extractionMethod: "inferred" (LLM extraction is never "direct")
 *   - confidence: LLM self-reported confidence (capped per HLD §14.2)
 */
export function convertToExtractedFacts(
  output: LLMRawProductOutput,
  sourceUrl: string
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  // Core product fields
  if (output.title) {
    facts.push(makeFact("title", output.title, output.title, `LLM extracted from ${sourceUrl}`, confidenceFor("title", output)));
  }

  if (output.brand) {
    facts.push(makeFact("brand", output.brand, output.brand, `LLM extracted brand from ${sourceUrl}`, confidenceFor("brand", output)));
  }

  if (output.gtin) {
    facts.push(makeFact("gtin", output.gtin, output.gtin.trim(), `LLM extracted GTIN from ${sourceUrl}`, confidenceFor("gtin", output)));
  }

  if (output.model_number) {
    facts.push(
      makeFact("model_number", output.model_number, output.model_number.trim(), `LLM extracted model from ${sourceUrl}`, confidenceFor("model_number", output))
    );
  }

  if (output.description) {
    facts.push(
      makeFact("description", output.description, output.description, `LLM extracted description from ${sourceUrl}`, confidenceFor("description", output))
    );
  }

  if (output.base_price != null) {
    facts.push(
      makeFact("base_price", output.base_price, output.base_price, `LLM extracted price from ${sourceUrl}`, confidenceFor("base_price", output), output.currency ? "currency" : null)
    );
  }

  if (output.currency) {
    facts.push(
      makeFact("currency", output.currency, output.currency.toUpperCase(), `LLM extracted currency from ${sourceUrl}`, confidenceFor("currency", output))
    );
  }

  // Category as a fact (for category detector to process)
  if (output.category_path) {
    facts.push(
      makeFact("productType", output.category_path, output.category_path, `LLM classified category from ${sourceUrl}`, confidenceFor("category_path", output))
    );
  }

  // Images
  if (output.images && output.images.length > 0) {
    const validImages = output.images.filter((img) => img.url && img.url.startsWith("http"));
    if (validImages.length > 0) {
      const normalized = validImages.map((img) => ({
        url: img.url,
        altText: img.alt_text ?? null,
      }));
      facts.push(
        makeFact("images", output.images, normalized, `LLM extracted ${validImages.length} images from ${sourceUrl}`, confidenceFor("images", output))
      );
    }
  }

  // Category-specific attributes
  if (output.attributes) {
    for (const [key, value] of Object.entries(output.attributes)) {
      if (value != null && value !== "") {
        facts.push(
          makeFact(key, value, value, `LLM extracted attribute '${key}' from ${sourceUrl}`, confidenceFor(key, output))
        );
      }
    }
  }

  // Variants — use a single "variants" key for all variant-level confidence
  if (output.variants && output.variants.length > 0) {
    const variantConf = confidenceFor("variants", output);
    output.variants.forEach((variant, i) => {
      if (variant.sku) {
        facts.push(
          makeFact(`variants[${i}].sku`, variant.sku, variant.sku.trim(), `LLM extracted variant SKU from ${sourceUrl}`, variantConf)
        );
      }
      if (variant.barcode) {
        facts.push(
          makeFact(`variants[${i}].barcode`, variant.barcode, variant.barcode.trim(), `LLM extracted variant barcode from ${sourceUrl}`, variantConf)
        );
      }
      if (variant.price != null) {
        facts.push(
          makeFact(`variants[${i}].price`, variant.price, variant.price, `LLM extracted variant price from ${sourceUrl}`, variantConf)
        );
      }
      if (variant.option_values) {
        for (const [optName, optValue] of Object.entries(variant.option_values)) {
          facts.push(
            makeFact(`variants[${i}].option.${optName}`, optValue, optValue, `LLM extracted variant option from ${sourceUrl}`, variantConf)
          );
        }
      }
    });
  }

  return facts;
}

function makeFact(
  rawKey: string,
  extractedValue: unknown,
  normalizedValue: unknown,
  sourcePointer: string,
  confidence: number,
  unit: string | null = null
): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null, // Assigned by semantic mapper
    extractedValue,
    normalizedValue,
    unit,
    sourcePointer,
    extractionMethod: "inferred", // LLM extraction is always "inferred"
    confidence,
    mappingMethod: null,
    mappingCandidates: null,
    approved: false,
  };
}
