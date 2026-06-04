// Coverage check for the merged structured facts.
//
// checkCoverage(facts, categoryRequiredAttributes) reports whether the core
// fields (title / base_price / currency / productType), at least one variant,
// and any category-required attributes are present, returning the missing keys
// as `gaps`. Called by extractStructured (index.ts) to decide if a page needs
// downstream gap-fill.

import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

const CORE_REQUIRED = ["title", "base_price", "currency", "productType"];
const VARIANT_HINT_REGEX = /^variants\[\d+\]\.option\./;

export interface CoverageResult {
  complete: boolean;
  gaps: string[];
}

export function checkCoverage(
  facts: ExtractedFact[],
  categoryRequiredAttributes: string[]
): CoverageResult {
  const have = new Set<string>();
  for (const f of facts) {
    if (CORE_REQUIRED.includes(f.rawKey)) have.add(f.rawKey);
    if (VARIANT_HINT_REGEX.test(f.rawKey)) have.add("variants");
    if (categoryRequiredAttributes.includes(f.rawKey)) have.add(f.rawKey);
  }

  const gaps: string[] = [];
  for (const r of CORE_REQUIRED) if (!have.has(r)) gaps.push(r);
  if (!have.has("variants")) gaps.push("variants");
  for (const r of categoryRequiredAttributes) if (!have.has(r)) gaps.push(r);

  return { complete: gaps.length === 0, gaps };
}
