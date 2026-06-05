import { test, expect } from "bun:test";
import { resolveActiveSchema } from "./schema.js";
import { PROTECTED_KEYS } from "./seed/attribute-catalog.js";

const keysOf = (s: ReturnType<typeof resolveActiveSchema>) => new Set(s.fields.map((f) => f.key));

test("jeans resolve to apparel: has fit/fabric, NOT storage", () => {
  const s = resolveActiveSchema({ categoryPath: "clothing/men/jeans", title: "Slim Fit Jeans" });
  expect(s.archetypeId).toBe("apparel");
  const keys = keysOf(s);
  expect(keys.has("fit")).toBe(true);
  expect(keys.has("fabric")).toBe(true);
  expect(keys.has("storage")).toBe(false);
});

test("smartphone resolves to storage/ram, NOT fabric", () => {
  const s = resolveActiveSchema({ categoryPath: "mobile_phones", title: "Google Pixel 10 5G" });
  expect(s.archetypeId).toBe("smartphone");
  const keys = keysOf(s);
  expect(keys.has("storage")).toBe(true);
  expect(keys.has("ram")).toBe(true);
  expect(keys.has("fabric")).toBe(false);
});

test("protected commerce facts are never in the enrichment schema", () => {
  const s = resolveActiveSchema({ title: "Google Pixel 10 5G", categoryPath: "mobile_phones" });
  for (const f of s.fields) expect(PROTECTED_KEYS.has(f.key)).toBe(false);
  const keys = keysOf(s);
  expect(keys.has("base_price")).toBe(false);
  expect(keys.has("currency")).toBe(false);
  expect(keys.has("identifier")).toBe(false);
});

test("unknown product falls back to generic and still enriches", () => {
  const s = resolveActiveSchema({ title: "Stainless Steel Water Bottle 1L", brand: "Acme" });
  expect(s.archetypeId).toBe("generic");
  expect(s.fellBackToGeneric).toBe(true);
  const keys = keysOf(s);
  expect(keys.has("meta_title")).toBe(true);
  expect(keys.has("faq")).toBe(true);
  expect(keys.has("category_path")).toBe(true);
});

test("universal marketing/seo/aeo/category fields present for any archetype", () => {
  const s = resolveActiveSchema({ categoryPath: "clothing", title: "Cotton Shirt" });
  const keys = keysOf(s);
  for (const k of ["benefits", "meta_description", "faq", "pros_cons", "google_category"]) {
    expect(keys.has(k)).toBe(true);
  }
});
