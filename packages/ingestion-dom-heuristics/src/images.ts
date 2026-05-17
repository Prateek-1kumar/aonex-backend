import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

const ICON_PATH = /\/(favicon|icon|sprite|logo)/i;
const SIZE_SUFFIX_PATTERN = /[_-]\d{2,4}x\d{2,4}(?=\.[a-z]{2,4}(?:$|\?))/i;

function urlStem(url: string): string {
  const noQuery = url.split("?")[0]!;
  return noQuery.replace(SIZE_SUFFIX_PATTERN, "").toLowerCase();
}

export function extractImagesFromDom(rawHtml: string): ExtractedFact[] {
  const $ = cheerio.load(rawHtml);
  const candidates: Array<{ url: string; source: string; confidence: number }> = [];

  $('meta[property="og:image"]').each((_i, el) => {
    const v = $(el).attr("content");
    if (v && !ICON_PATH.test(v) && !v.startsWith("data:")) {
      candidates.push({ url: v, source: "og:image", confidence: 0.80 });
    }
  });

  $("img").each((i, el) => {
    const src = $(el).attr("src") ?? $(el).attr("data-src") ?? "";
    if (!src || src.startsWith("data:") || ICON_PATH.test(src)) return;
    const w = Number($(el).attr("width") ?? "0");
    const h = Number($(el).attr("height") ?? "0");
    if ((Number.isFinite(w) && w > 0 && w < 200) || (Number.isFinite(h) && h > 0 && h < 200)) return;
    candidates.push({ url: src, source: `img[${i}]`, confidence: 0.60 });
  });

  const seen = new Set<string>();
  const facts: ExtractedFact[] = [];
  candidates.sort((a, b) => b.confidence - a.confidence);
  for (const c of candidates) {
    const stem = urlStem(c.url);
    if (seen.has(stem)) continue;
    seen.add(stem);
    facts.push({
      rawKey: "image_url",
      canonicalPath: null,
      extractedValue: c.url,
      normalizedValue: null,
      unit: null,
      sourcePointer: `dom_heuristic:${c.source}`,
      extractionMethod: "inferred",
      mappingMethod: null,
      mappingCandidates: null,
      sourceAlternatives: null,
      confidence: c.confidence,
      approved: false,
    });
    if (facts.length >= 10) break;
  }
  return facts;
}
