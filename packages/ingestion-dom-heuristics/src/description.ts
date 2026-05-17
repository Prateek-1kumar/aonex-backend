import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

export function extractDescriptionFromDom(
  rawHtml: string
): ExtractedFact | null {
  const $ = cheerio.load(rawHtml);
  const candidates: Array<{
    text: string;
    source: string;
    confidence: number;
  }> = [];

  const og = $('meta[property="og:description"]').attr("content");
  if (og && og.trim().length >= 20)
    candidates.push({
      text: og.trim(),
      source: 'meta[property="og:description"]',
      confidence: 0.8,
    });

  const meta = $('meta[name="description"]').attr("content");
  if (meta && meta.trim().length >= 20)
    candidates.push({
      text: meta.trim(),
      source: 'meta[name="description"]',
      confidence: 0.7,
    });

  // Look for description-classed elements
  let longest = "";
  let longestSelector = "";
  $('[class*="description" i], [id*="description" i]').each((_i, el) => {
    const text = $(el).text().trim();
    if (text.length > longest.length) {
      longest = text;
      const cls = $(el).attr("class") ?? $(el).attr("id") ?? "?";
      longestSelector = `desc:${cls}`;
    }
  });
  if (longest.length >= 20)
    candidates.push({
      text: longest,
      source: longestSelector,
      confidence: 0.55,
    });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0]!;

  return {
    rawKey: "description",
    canonicalPath: null,
    extractedValue: best.text,
    normalizedValue: null,
    unit: null,
    sourcePointer: `dom_heuristic:${best.source}`,
    extractionMethod: "inferred",
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    confidence: best.confidence,
    approved: false,
  };
}
