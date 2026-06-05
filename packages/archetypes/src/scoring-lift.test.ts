// The headline of the enrichment upgrade: scoreCompletenessPercent measures the
// FULL content schema (archetype specs ∪ universal content) with commerce facts
// discounted — so a raw product scores low and a fully enriched one reaches ~90%+,
// while the lean registry keeps ingestion gap-fill + the admission gate unchanged.

import { test, expect } from "bun:test";
import { getArchetype } from "./registry.js";
import { scoreCompletenessPercent } from "./completeness.js";
import { universalSpecs } from "./seed/attribute-catalog.js";

const apparel = getArchetype("apparel")!;
const scoredFields = new Set([
  ...apparel.attributes.map((a) => a.field),
  ...universalSpecs().map((s) => s.field),
]);

test("registry stays lean (no universal content leaks into ingestion specs)", () => {
  const lean = new Set(apparel.attributes.map((a) => a.field));
  expect(lean.has("meta_description")).toBe(false);
  expect(lean.has("faq")).toBe(false);
  // ...but the scored content schema includes them.
  for (const k of ["description_long", "key_features", "meta_description", "seo_keywords", "faq", "category_path"]) {
    expect(scoredFields.has(k)).toBe(true);
  }
});

test("raw apparel scores low; fully-enriched apparel reaches ~90%+", () => {
  const raw = new Set(["title", "brand", "base_price", "currency", "images"]);
  const rawPct = scoreCompletenessPercent(apparel, raw).percent;

  // Everything enrichment can fill, present — but NOT the protected identifier
  // (enrichment is forbidden to add it), proving the score still clears ~90%.
  const enriched = new Set(scoredFields);
  enriched.delete("identifier");
  const enrichedPct = scoreCompletenessPercent(apparel, enriched).percent;

  expect(rawPct).toBeLessThan(55);
  expect(enrichedPct).toBeGreaterThan(88);
  expect(enrichedPct - rawPct).toBeGreaterThan(35);
});
