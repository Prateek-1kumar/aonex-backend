// The headline of the enrichment upgrade: with the universal content schema now
// SCORED and commerce facts down-weighted, a raw product scores low and a fully
// enriched one reaches ~90%+ — so enrichment visibly pays off.

import { test, expect } from "bun:test";
import { getArchetype } from "./registry.js";
import { scoreCompletenessPercent } from "./completeness.js";

const apparel = getArchetype("apparel")!;

test("universal content fields are merged into the scored archetype", () => {
  const fields = new Set(apparel.attributes.map((a) => a.field));
  for (const k of ["description_long", "key_features", "meta_description", "seo_keywords", "faq", "category_path"]) {
    expect(fields.has(k)).toBe(true);
  }
});

test("raw apparel scores low; fully-enriched apparel reaches ~90%+", () => {
  const raw = new Set(["title", "brand", "base_price", "currency", "images"]);
  const rawPct = scoreCompletenessPercent(apparel, raw).percent;

  // Everything enrichment can fill, present — but NOT the protected identifier
  // (enrichment is forbidden to add it), proving the score still clears 90%.
  const enriched = new Set(apparel.attributes.map((a) => a.field));
  enriched.delete("identifier");
  const enrichedPct = scoreCompletenessPercent(apparel, enriched).percent;

  expect(rawPct).toBeLessThan(55);
  expect(enrichedPct).toBeGreaterThan(88);
  expect(enrichedPct - rawPct).toBeGreaterThan(35);
});
