import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.65;

/**
 * BreadcrumbList parser — finds Schema.org BreadcrumbList blocks in JSON-LD
 * and proposes a category_path candidate by joining the breadcrumb chain
 * (minus the last entry, which is usually the product name itself).
 *
 * Confidence is weighted by chain depth: 0.50 + 0.10 * min(chainLen, 4).
 * A depth-1 chain scores 0.60; a depth-4+ chain scores 0.90.
 */
export function parseBreadcrumbList(
  jsonLdBlocks: Record<string, unknown>[]
): ParserOutput {
  const empty: ParserOutput = {
    kind: "breadcrumb_list",
    facts: [],
    baselineConfidence: BASELINE_CONFIDENCE,
  };

  // 1. Find the first BreadcrumbList block.
  const block = jsonLdBlocks.find((b) => b["@type"] === "BreadcrumbList");
  if (!block) return empty;

  // 2. Extract itemListElement array.
  const rawItems = block["itemListElement"];
  if (!Array.isArray(rawItems) || rawItems.length === 0) return empty;

  // 3. Filter to valid ListItem records with a name field, sort by position.
  const items = (rawItems as unknown[])
    .filter(isRecord)
    .filter((item) => typeof item["name"] === "string")
    .sort((a, b) => {
      const pa = typeof a["position"] === "number" ? a["position"] : Infinity;
      const pb = typeof b["position"] === "number" ? b["position"] : Infinity;
      return pa - pb;
    });

  if (items.length === 0) return empty;

  // 4. Drop the last entry (typically the product's own name — too specific).
  const chainItems = items.slice(0, -1);
  if (chainItems.length === 0) return empty;

  // 5. Map to names and join with "/" (lowercased).
  const names = chainItems.map((item) => (item["name"] as string).trim());
  const categoryPath = names.map((n) => n.toLowerCase()).join("/");

  // 6. Compute per-fact confidence based on chain depth.
  const chainLen = chainItems.length;
  const factConfidence = 0.50 + 0.10 * Math.min(chainLen, 4);

  const fact: ExtractedFact = {
    rawKey: "category_path",
    canonicalPath: null,
    extractedValue: categoryPath,
    normalizedValue: categoryPath,
    unit: null,
    sourcePointer: "breadcrumb_list:itemListElement",
    extractionMethod: "computed",
    confidence: factConfidence,
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    approved: false,
  };

  return {
    kind: "breadcrumb_list",
    facts: [fact],
    baselineConfidence: BASELINE_CONFIDENCE,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
