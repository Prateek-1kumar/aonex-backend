import * as cheerio from "cheerio";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

function toSnake(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function extractSpecTableFromDom(rawHtml: string): ExtractedFact[] {
  const $ = cheerio.load(rawHtml);
  const facts: ExtractedFact[] = [];

  // <table> rows with th + td pattern
  $("table tr").each((rowIdx, row) => {
    const cells = $(row).find("th, td");
    if (cells.length !== 2) return;
    const label = $(cells[0]).text().trim();
    const value = $(cells[1]).text().trim();
    if (!label || !value) return;
    const key = toSnake(label);
    if (!key) return;
    facts.push({
      rawKey: key,
      canonicalPath: null,
      extractedValue: value,
      normalizedValue: null,
      unit: null,
      sourcePointer: `dom_heuristic:spec_table[${rowIdx}]:${label}`,
      extractionMethod: "inferred",
      mappingMethod: null,
      mappingCandidates: null,
      sourceAlternatives: null,
      confidence: 0.70,
      approved: false,
    });
  });

  // <dl>/<dt>/<dd>
  $("dl").each((dlIdx, dl) => {
    const dts = $(dl).find("dt");
    const dds = $(dl).find("dd");
    const n = Math.min(dts.length, dds.length);
    for (let i = 0; i < n; i++) {
      const label = $(dts[i]).text().trim();
      const value = $(dds[i]).text().trim();
      if (!label || !value) continue;
      const key = toSnake(label);
      if (!key) continue;
      facts.push({
        rawKey: key,
        canonicalPath: null,
        extractedValue: value,
        normalizedValue: null,
        unit: null,
        sourcePointer: `dom_heuristic:dl[${dlIdx}].dt[${i}]:${label}`,
        extractionMethod: "inferred",
        mappingMethod: null,
        mappingCandidates: null,
        sourceAlternatives: null,
        confidence: 0.70,
        approved: false,
      });
    }
  });

  return facts;
}
