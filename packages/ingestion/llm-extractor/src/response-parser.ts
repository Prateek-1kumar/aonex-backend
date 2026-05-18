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
  role: z.enum(["hero","gallery","swatch","lifestyle","spec","video_thumb"]).optional(),
  position: z.number().int().optional(),
  alt_text: z.string().nullable().optional().default(null),
  width: z.number().int().nullable().optional().default(null),
  height: z.number().int().nullable().optional().default(null),
  variant_refs: z.array(z.string()).optional().default([])
}).passthrough();

const PricingObjectSchema = z.object({
  list_price: z.number().nullable().optional().default(null),
  sale_price: z.number().nullable().optional().default(null),
  currency: z.string().max(3).nullable().optional().default(null),
  discount_percent: z.number().nullable().optional().default(null),
  price_per_unit: z.string().nullable().optional().default(null)
}).passthrough();

const VariantSchema = z.object({
  sku: z.string().nullable().optional().default(null),
  barcode: z.string().nullable().optional().default(null),
  price: z.number().nullable().optional().default(null),
  pricing: PricingObjectSchema.optional(),
  option_values: z.record(z.string()).optional().default({}),
  inventory_quantity: z.number().int().nullable().optional().default(null),
  image_urls: z.array(z.string()).optional().default([])
}).passthrough();

const ShippingSchema = z.object({
  free_shipping: z.boolean().nullable().optional().default(null),
  shipping_cost: z.number().nullable().optional().default(null),
  weight: z.object({ value: z.number(), unit: z.string() }).nullable().optional().default(null),
  dimensions: z.object({
    length: z.number(),
    width: z.number(),
    height: z.number(),
    unit: z.string()
  }).nullable().optional().default(null)
}).passthrough();

const LLMOutputSchema = z.object({
  title: z.string().nullable().optional().default(null),
  brand: z.string().nullable().optional().default(null),
  gtin: z.string().nullable().optional().default(null),
  mpn: z.string().nullable().optional().default(null),
  model_number: z.string().nullable().optional().default(null),
  sku: z.string().nullable().optional().default(null),

  description: z.string().nullable().optional().default(null),
  description_short: z.string().nullable().optional().default(null),
  description_long: z.string().nullable().optional().default(null),
  highlights: z.array(z.string()).optional().default([]),

  category_path: z.string().nullable().optional().default(null),
  category_confidence: z.number().min(0).max(1).optional().default(0.5),
  breadcrumbs: z.array(z.string()).optional().default([]),

  base_price: z.number().nullable().optional().default(null),
  currency: z.string().max(3).nullable().optional().default(null),
  pricing: PricingObjectSchema.optional(),

  ratings: z.object({
    average: z.number().nullable().optional().default(null),
    count: z.number().nullable().optional().default(null)
  }).optional().default({ average: null, count: null }),

  seller: z.object({
    name: z.string().nullable().optional().default(null),
    is_official: z.boolean().nullable().optional().default(null)
  }).optional().default({ name: null, is_official: null }),

  images: z.array(ImageSchema).optional().default([]),
  options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).optional().default([]),
  variants: z.array(VariantSchema).optional().default([]),
  attributes: z.record(z.unknown()).optional().default({}),

  shipping: ShippingSchema.optional(),
  warranty: z.string().nullable().optional().default(null),
  return_policy: z.string().nullable().optional().default(null),

  error: z.string().nullable().optional(),
  _field_confidence: z.record(z.number().min(0).max(1)).optional(),
  _correction_notes: z.record(z.string()).optional()
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

  // Pricing object (if present, overrides legacy base_price)
  const p = output.pricing;
  if (p) {
    if (p.list_price != null) {
      facts.push(makeFact("list_price", p.list_price, p.list_price, `LLM extracted list price from ${sourceUrl}`, confidenceFor("list_price", output)));
    }
    if (p.sale_price != null) {
      facts.push(makeFact("sale_price", p.sale_price, p.sale_price, `LLM extracted sale price from ${sourceUrl}`, confidenceFor("sale_price", output)));
    }
    if (p.discount_percent != null) {
      facts.push(makeFact("discount_percent", p.discount_percent, p.discount_percent, `LLM extracted discount percent from ${sourceUrl}`, confidenceFor("discount_percent", output)));
    }
    if (p.price_per_unit) {
      facts.push(makeFact("price_per_unit", p.price_per_unit, p.price_per_unit, `LLM extracted price per unit from ${sourceUrl}`, confidenceFor("price_per_unit", output)));
    }
    if (p.currency && !output.currency) {
      facts.push(makeFact("currency", p.currency, p.currency.toUpperCase(), `LLM extracted currency from ${sourceUrl}`, confidenceFor("currency", output)));
    }
  }

  // Ratings
  if (output.ratings) {
    if (output.ratings.average != null) {
      facts.push(makeFact("rating_average", output.ratings.average, output.ratings.average, `LLM extracted rating average from ${sourceUrl}`, confidenceFor("rating_average", output)));
    }
    if (output.ratings.count != null) {
      facts.push(makeFact("rating_count", output.ratings.count, output.ratings.count, `LLM extracted rating count from ${sourceUrl}`, confidenceFor("rating_count", output)));
    }
  }

  // Seller
  if (output.seller?.name) {
    facts.push(makeFact("seller_name", output.seller.name, output.seller.name, `LLM extracted seller name from ${sourceUrl}`, confidenceFor("seller_name", output)));
  }
  if (output.seller?.is_official != null) {
    facts.push(makeFact("seller_is_official", output.seller.is_official, output.seller.is_official, `LLM extracted seller official flag from ${sourceUrl}`, confidenceFor("seller_is_official", output)));
  }

  // Highlights and breadcrumbs
  if (output.highlights && output.highlights.length > 0) {
    facts.push(makeFact("highlights", output.highlights, output.highlights, `LLM extracted ${output.highlights.length} highlights from ${sourceUrl}`, confidenceFor("highlights", output)));
  }
  if (output.breadcrumbs && output.breadcrumbs.length > 0) {
    facts.push(makeFact("breadcrumbs", output.breadcrumbs, output.breadcrumbs, `LLM extracted breadcrumbs from ${sourceUrl}`, confidenceFor("breadcrumbs", output)));
  }

  // Options
  if (output.options && output.options.length > 0) {
    facts.push(makeFact("options", output.options, output.options, `LLM extracted option groups from ${sourceUrl}`, confidenceFor("options", output)));
  }

  // Shipping
  if (output.shipping) {
    const s = output.shipping;
    if (s.free_shipping != null) {
      facts.push(makeFact("shipping_free", s.free_shipping, s.free_shipping, `LLM extracted free-shipping flag from ${sourceUrl}`, confidenceFor("shipping_free", output)));
    }
    if (s.shipping_cost != null) {
      facts.push(makeFact("shipping_cost", s.shipping_cost, s.shipping_cost, `LLM extracted shipping cost from ${sourceUrl}`, confidenceFor("shipping_cost", output)));
    }
    if (s.weight != null) {
      facts.push(makeFact("weight", s.weight, s.weight, `LLM extracted weight from ${sourceUrl}`, confidenceFor("weight", output), s.weight.unit));
    }
    if (s.dimensions != null) {
      facts.push(makeFact("dimensions", s.dimensions, s.dimensions, `LLM extracted dimensions from ${sourceUrl}`, confidenceFor("dimensions", output), s.dimensions.unit));
    }
  }

  // Warranty / return policy
  if (output.warranty) {
    facts.push(makeFact("warranty", output.warranty, output.warranty, `LLM extracted warranty from ${sourceUrl}`, confidenceFor("warranty", output)));
  }
  if (output.return_policy) {
    facts.push(makeFact("return_policy", output.return_policy, output.return_policy, `LLM extracted return policy from ${sourceUrl}`, confidenceFor("return_policy", output)));
  }

  // Identity additions
  if (output.mpn) {
    facts.push(makeFact("mpn", output.mpn, output.mpn.trim(), `LLM extracted MPN from ${sourceUrl}`, confidenceFor("mpn", output)));
  }
  if (output.sku) {
    facts.push(makeFact("sku", output.sku, output.sku.trim(), `LLM extracted SKU from ${sourceUrl}`, confidenceFor("sku", output)));
  }

  // Long/short description
  if (output.description_short) {
    facts.push(makeFact("description_short", output.description_short, output.description_short, `LLM extracted short description from ${sourceUrl}`, confidenceFor("description_short", output)));
  }
  if (output.description_long) {
    facts.push(makeFact("description_long", output.description_long, output.description_long, `LLM extracted long description from ${sourceUrl}`, confidenceFor("description_long", output)));
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
    for (const [key, raw] of Object.entries(output.attributes)) {
      if (raw == null || raw === "") continue;
      let value: unknown = raw;
      let unit: string | null = null;
      if (raw && typeof raw === "object" && "value" in (raw as Record<string, unknown>)) {
        const obj = raw as { value: unknown; unit?: string | null };
        value = obj.value;
        unit = obj.unit ?? null;
      }
      facts.push(
        makeFact(key, value, value, `LLM extracted attribute '${key}' from ${sourceUrl}`, confidenceFor(key, output), unit)
      );
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
      if (variant.pricing) {
        if (variant.pricing.list_price != null) {
          facts.push(
            makeFact(`variants[${i}].list_price`, variant.pricing.list_price, variant.pricing.list_price, `LLM extracted variant list price from ${sourceUrl}`, variantConf)
          );
        }
        if (variant.pricing.sale_price != null) {
          facts.push(
            makeFact(`variants[${i}].sale_price`, variant.pricing.sale_price, variant.pricing.sale_price, `LLM extracted variant sale price from ${sourceUrl}`, variantConf)
          );
        }
      }
      if (variant.image_urls && variant.image_urls.length > 0) {
        facts.push(
          makeFact(`variants[${i}].image_urls`, variant.image_urls, variant.image_urls, `LLM extracted variant images from ${sourceUrl}`, variantConf)
        );
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
    sourceAlternatives: null,
    approved: false,
  };
}
