import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.65;

const OG_TO_RAWKEY: Record<string, string> = {
  "og:title": "title",
  "og:description": "description",
  "og:image": "images",
  "product:price:amount": "base_price",
  "product:price:currency": "currency",
  "product:brand": "brand",
  "product:retailer_item_id": "mpn",
};

export function parseOpenGraph(html: string): ParserOutput {
  const facts: ExtractedFact[] = [];
  for (const m of html.matchAll(
    /<meta[^>]*property=["']([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi
  )) {
    const property = m[1]!;
    const content = m[2]!.trim();
    if (!content) continue;
    const rawKey = OG_TO_RAWKEY[property];
    if (!rawKey) continue;
    const value =
      rawKey === "base_price" ? Number(content) || content : content;
    const normalized =
      rawKey === "images"
        ? [{ url: content, altText: null }]
        : value;
    facts.push({
      rawKey,
      canonicalPath: null,
      extractedValue: value,
      normalizedValue: normalized,
      unit: null,
      sourcePointer: `opengraph:${property}`,
      extractionMethod: "direct",
      confidence: BASELINE_CONFIDENCE,
      mappingMethod: null,
      mappingCandidates: null,
      approved: false,
    });
  }
  return { kind: "opengraph", facts, baselineConfidence: BASELINE_CONFIDENCE };
}
