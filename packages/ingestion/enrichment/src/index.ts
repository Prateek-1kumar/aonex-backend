// Public API for @aonex/ingestion-enrichment.
// Filled in by Tasks 3.2-3.7.

export { normalizeImageUrls, type RawImg, type NormalizedImg } from "./image-normalizer.js";
export { classifyImageRoles, type ImageRole, type RoledImg } from "./image-role-classifier.js";
export { linkVariantsToImages, type VariantInput, type LinkedVariant } from "./variant-image-linker.js";
export { parseUnit } from "./unit-parser.js";
export {
  validatePricing,
  validateGtin,
  dedupeVariantSkus,
  type ValidationWarning,
  type ValidationResult,
  type PricingInput
} from "./sanity-validators.js";

export type SourceTag = "structured" | "dom" | "llm-text" | "llm-hints" | "llm-link" | "vision" | "per-site" | "enrichment";

export interface SkuImage {
  url: string;
  role: "hero" | "gallery" | "swatch" | "lifestyle" | "spec" | "video_thumb";
  position: number;
  alt_text: string | null;
  width: number | null;
  height: number | null;
  variant_refs: string[];
}

export interface SkuVariant {
  sku: string | null;
  barcode: string | null;
  option_values: Record<string, string>;
  pricing: { list_price: number | null; sale_price: number | null; currency: string | null };
  image_urls: string[];
}

export interface SkuJson {
  title: string | null;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  model_number: string | null;
  sku: string | null;
  description_short: string | null;
  description_long: string | null;
  highlights: string[];
  category_path: string | null;
  category_confidence: number;
  breadcrumbs: string[];
  pricing: {
    list_price: number | null;
    sale_price: number | null;
    currency: string | null;
    discount_percent: number | null;
    price_per_unit: string | null;
  };
  ratings: { average: number | null; count: number | null };
  seller: { name: string | null; is_official: boolean | null };
  images: SkuImage[];
  options: Array<{ name: string; values: string[] }>;
  variants: SkuVariant[];
  attributes: Record<string, { value: unknown; unit: string | null; source: SourceTag }>;
  shipping: {
    free_shipping: boolean | null;
    shipping_cost: number | null;
    weight: { value: number; unit: string } | null;
    dimensions: { length: number; width: number; height: number; unit: string } | null;
  };
  warranty: string | null;
  return_policy: string | null;
  _field_confidence: Record<string, number>;
  _field_source: Record<string, SourceTag>;
  _extraction_meta: {
    passes_run: string[];
    tokens_used: number;
    cost_usd: number;
    latency_ms: number;
    escalated_to: "static" | "browser" | "unblock";
    budget_exceeded?: boolean;
    validation_warnings?: { field: string; reason: string }[];
  };
}

export { convertFromFacts } from "./sku-builder.js";
