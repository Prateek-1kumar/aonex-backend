import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.80;

const PROP_TO_RAWKEY: Record<string, string> = {
  name: "title",
  brand: "brand",
  price: "base_price",
  priceCurrency: "currency",
  description: "description",
  image: "images",
  sku: "mpn",
  gtin13: "gtin",
  gtin12: "gtin",
};

export function parseMicrodata(html: string): ParserOutput {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  const pushFact = (prop: string, value: string) => {
    const rawKey = PROP_TO_RAWKEY[prop];
    if (!rawKey || seen.has(prop)) return;
    seen.add(prop);
    facts.push({
      rawKey,
      canonicalPath: null,
      extractedValue: rawKey === "base_price" ? Number(value) || value : value,
      normalizedValue: rawKey === "base_price" ? Number(value) || value : value,
      unit: null,
      sourcePointer: `microdata:itemprop=${prop}`,
      extractionMethod: "direct",
      confidence: BASELINE_CONFIDENCE,
      mappingMethod: null,
      mappingCandidates: null,
      approved: false,
    });
  };

  // Tags with content= attribute (e.g. <meta itemprop="price" content="49.99">)
  for (const m of html.matchAll(
    /<[^>]*itemprop=["']([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi
  )) {
    const value = m[2]!.trim();
    if (value) pushFact(m[1]!, value);
  }

  // Tags with text content (e.g. <span itemprop="name">Cool Shirt</span>)
  for (const m of html.matchAll(
    /<[a-z][^>]*itemprop=["']([^"']+)["'][^>]*>([^<]+)</gi
  )) {
    const value = m[2]!.trim();
    if (value) pushFact(m[1]!, value);
  }

  return { kind: "microdata", facts, baselineConfidence: BASELINE_CONFIDENCE };
}
