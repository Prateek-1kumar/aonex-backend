import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

function toSnake(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function extractVariantSelectorFromDom(rawHtml: string): ExtractedFact[] {
  const $ = cheerio.load(rawHtml);
  const facts: ExtractedFact[] = [];

  // <select name="size">
  $("select[name]").each((_i, sel) => {
    const name = $(sel).attr("name") ?? "";
    if (!name) return;
    const key = toSnake(name);
    if (!key) return;
    const options: string[] = [];
    $(sel).find("option").each((_j, opt) => {
      const text = $(opt).text().trim();
      const value = ($(opt).attr("value") ?? text).trim();
      if (value && !options.includes(value)) options.push(value);
    });
    if (options.length === 0) return;
    facts.push({
      rawKey: key,
      canonicalPath: null,
      extractedValue: options,
      normalizedValue: null,
      unit: null,
      sourcePointer: `dom_heuristic:select[name=${name}]`,
      extractionMethod: "inferred",
      mappingMethod: null,
      mappingCandidates: null,
      sourceAlternatives: null,
      confidence: 0.65,
      approved: false,
    });
  });

  // radio groups: group by name attribute
  const radioGroups = new Map<string, string[]>();
  $("input[type='radio'][name]").each((_i, rad) => {
    const name = $(rad).attr("name") ?? "";
    const value = $(rad).attr("value") ?? "";
    if (!name || !value) return;
    const list = radioGroups.get(name) ?? [];
    if (!list.includes(value)) list.push(value);
    radioGroups.set(name, list);
  });
  for (const [name, options] of radioGroups) {
    const key = toSnake(name);
    if (!key) continue;
    facts.push({
      rawKey: key,
      canonicalPath: null,
      extractedValue: options,
      normalizedValue: null,
      unit: null,
      sourcePointer: `dom_heuristic:radio[name=${name}]`,
      extractionMethod: "inferred",
      mappingMethod: null,
      mappingCandidates: null,
      sourceAlternatives: null,
      confidence: 0.65,
      approved: false,
    });
  }

  return facts;
}
