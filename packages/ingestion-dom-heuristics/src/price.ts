import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

const CURRENCY_PATTERN =
  /(?:\$|€|£|₹|¥)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:USD|EUR|GBP|INR|JPY)/;
const PRICE_CLASS_PATTERN = /price|amount|cost/i;

export function extractPriceFromDom(rawHtml: string): ExtractedFact | null {
  const $ = cheerio.load(rawHtml);
  const candidates: Array<{
    value: number;
    source: string;
    confidence: number;
  }> = [];

  // Rung 1: itemprop="price"
  $('[itemprop="price"]').each((_i, el) => {
    const raw = $(el).attr("content") ?? $(el).text();
    const num = Number(String(raw).trim().replace(/[$,€£₹¥]/g, ""));
    if (Number.isFinite(num) && num > 0) {
      candidates.push({
        value: num,
        source: 'itemprop="price"',
        confidence: 0.9,
      });
    }
  });

  // Rung 2: class-named price elements
  $("*").each((_i, el) => {
    const cls = $(el).attr("class") ?? "";
    if (!PRICE_CLASS_PATTERN.test(cls)) return;
    // Only consider leaf-ish elements (avoid parent containers wrapping multiple prices)
    if ($(el).children().length > 5) return;
    const text = $(el).text();
    const match = text.match(CURRENCY_PATTERN);
    if (!match) return;
    const numStr = (match[1] ?? match[2] ?? "").replace(/,/g, "");
    const num = Number(numStr);
    if (Number.isFinite(num) && num > 0) {
      candidates.push({
        value: num,
        source: `class="${cls}"`,
        confidence: 0.65,
      });
    }
  });

  if (candidates.length === 0) return null;

  // Highest confidence; tiebreak on smallest value
  candidates.sort((a, b) => b.confidence - a.confidence || a.value - b.value);
  const best = candidates[0]!;

  return {
    rawKey: "base_price",
    canonicalPath: null,
    extractedValue: best.value,
    normalizedValue: null,
    unit: null,
    sourcePointer: `dom_heuristic:${best.source}`,
    extractionMethod: "inferred",
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: candidates.slice(1, 4).map((c) => ({
      value: c.value,
      sourcePointer: `dom_heuristic:${c.source}`,
      confidence: c.confidence,
    })),
    confidence: best.confidence,
    approved: false,
  };
}
