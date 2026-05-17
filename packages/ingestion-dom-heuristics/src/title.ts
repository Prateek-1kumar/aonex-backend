import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

const SUFFIX_PATTERN = /\s+[|\-–—]\s+.{2,40}$/;

export function extractTitleFromDom(rawHtml: string): ExtractedFact | null {
  const $ = cheerio.load(rawHtml);
  const candidates: Array<{
    text: string;
    source: string;
    confidence: number;
  }> = [];

  const og = $('meta[property="og:title"]').attr("content");
  if (og && og.trim())
    candidates.push({
      text: og.trim(),
      source: 'meta[property="og:title"]',
      confidence: 0.85,
    });

  const h1 = $("h1").first().text();
  if (h1 && h1.trim())
    candidates.push({ text: h1.trim(), source: "h1:first", confidence: 0.75 });

  const titleTag = $("title").first().text();
  if (titleTag && titleTag.trim()) {
    const stripped = titleTag.trim().replace(SUFFIX_PATTERN, "").trim();
    if (stripped)
      candidates.push({ text: stripped, source: "<title>", confidence: 0.55 });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0]!;

  return {
    rawKey: "title",
    canonicalPath: null,
    extractedValue: best.text,
    normalizedValue: null,
    unit: null,
    sourcePointer: `dom_heuristic:${best.source}`,
    extractionMethod: "inferred",
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: candidates.slice(1).map((c) => ({
      value: c.text,
      sourcePointer: `dom_heuristic:${c.source}`,
      confidence: c.confidence,
    })),
    confidence: best.confidence,
    approved: false,
  };
}
