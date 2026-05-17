import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

export type ParserKind =
  | "json_ld"
  | "shopify_probe"
  | "next_data"
  | "microdata"
  | "opengraph"
  | "nuxt"
  | "initial_state"
  | "magento"
  | "woocommerce"
  | "algolia"
  | "shopify_products_json"
  | "rdfa"
  | "breadcrumb_list";

export interface ParserOutput {
  kind: ParserKind;
  facts: ExtractedFact[];
  /**
   * Source-class baseline confidence used when emitting facts.
   * json_ld + shopify_probe: 0.95
   * next_data: 0.85
   * microdata: 0.80
   * opengraph: 0.65
   */
  baselineConfidence: number;
  diagnostics?: Record<string, unknown>;
}

export interface StructuredResult {
  facts: ExtractedFact[];
  byParser: Record<ParserKind, ParserOutput | null>;
  category: { path: string | null; confidence: number };
}
