import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

export function extractBreadcrumbFromDom(rawHtml: string): ExtractedFact | null {
  const $ = cheerio.load(rawHtml);
  const containers = $('[class*="breadcrumb" i], [id*="breadcrumb" i], nav[aria-label*="breadcrumb" i]');
  if (containers.length === 0) return null;

  const container = containers.first();
  const items: string[] = [];

  // If the breadcrumb uses <li> elements, use those (handles ul/ol breadcrumbs)
  const listItems = container.find("li");
  if (listItems.length > 0) {
    listItems.each((_i, el) => {
      const text = $(el).text().trim();
      if (!text || text === ">" || text === "/" || text === "›") return;
      if (items[items.length - 1] === text) return;
      items.push(text);
    });
  } else {
    // Fall back to scanning all direct child elements (a, span, etc.)
    container.children().each((_i, el) => {
      const text = $(el).text().trim();
      if (!text || text === ">" || text === "/" || text === "›") return;
      if (items[items.length - 1] === text) return;
      items.push(text);
    });
    // If no direct children had text, try all named elements
    if (items.length === 0) {
      container.find("a, span, strong, em").each((_i, el) => {
        const text = $(el).text().trim();
        if (!text || text === ">" || text === "/" || text === "›") return;
        if (items[items.length - 1] === text) return;
        items.push(text);
      });
    }
  }

  if (items.length < 2) return null;
  // Drop last (product name)
  const chain = items.slice(0, -1).map((s) => s.toLowerCase().replace(/\s+/g, "_"));
  if (chain.length === 0) return null;

  const path = chain.join("/");
  const confidence = 0.50 + 0.10 * Math.min(chain.length, 4);

  return {
    rawKey: "category_path",
    canonicalPath: null,
    extractedValue: path,
    normalizedValue: null,
    unit: null,
    sourcePointer: "dom_heuristic:breadcrumb",
    extractionMethod: "inferred",
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    confidence,
    approved: false,
  };
}
