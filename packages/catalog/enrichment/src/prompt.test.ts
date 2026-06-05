// The v2 prompt must demand the compulsory content block and guide deep,
// canonical categories — that is what lifts both richness and the score.

import { test, expect } from "bun:test";
import { resolveActiveSchema } from "@aonex/archetypes";
import { buildEnrichmentPrompt, ENRICH_PROMPT_VERSION } from "./prompt.js";
import type { ProductSnapshot } from "./types.js";

const jeans: ProductSnapshot = {
  productId: "p1",
  family: "apparel",
  current: { title: "Slim Fit Jeans" },
  facts: { hasPrice: true, hasCurrency: true, hasIdentifier: false, hasTitle: true },
  title: "Slim Fit Jeans",
  categoryPath: "clothing/men/jeans",
  brand: "Acme",
};

test("v2 prompt asks for the compulsory fields + deep category examples", () => {
  expect(ENRICH_PROMPT_VERSION).toBe("enrich-v2");
  const schema = resolveActiveSchema({ title: "Slim Fit Jeans", categoryPath: "clothing/men/jeans" });
  const [, user] = buildEnrichmentPrompt(jeans, schema);
  const text = user!.content;

  for (const k of ["description_short", "description_long", "key_features", "meta_description", "seo_keywords", "category_path"]) {
    expect(text).toContain(`"${k}"`);
  }
  // compulsory marker + worked deep-category example
  expect(text).toContain("★");
  expect(text).toContain("Bottomwear");
  expect(text).toContain("google_category");
});
