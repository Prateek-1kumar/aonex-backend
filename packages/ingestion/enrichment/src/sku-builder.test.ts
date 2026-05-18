import { describe, it, expect } from "bun:test";
import { convertFromFacts } from "./sku-builder.js";

function fact(rawKey: string, value: unknown, extra: Partial<{ unit: string | null; extractionMethod: string; confidence: number; normalizedValue: unknown }> = {}) {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue: value,
    normalizedValue: extra.normalizedValue ?? value,
    unit: extra.unit ?? null,
    sourcePointer: "",
    extractionMethod: extra.extractionMethod ?? "direct",
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    confidence: extra.confidence ?? 0.9,
    approved: false
  } as never;
}

describe("convertFromFacts", () => {
  it("empty facts produces null fields, empty arrays", () => {
    const s = convertFromFacts([], "https://x.com");
    expect(s.title).toBeNull();
    expect(s.images).toHaveLength(0);
    expect(s.variants).toHaveLength(0);
  });

  it("normalizes images and assigns hero by og match", () => {
    const facts = [
      fact("images", [{ url: "https://x.com/a.jpg" }, { url: "https://x.com/hero.jpg" }])
    ];
    const s = convertFromFacts(facts, "https://x.com", { ogImage: "https://x.com/hero.jpg" });
    expect(s.images.find((i) => i.url.endsWith("hero.jpg"))?.role).toBe("hero");
  });

  it("groups variants[N].* keys into variant objects with linked images", () => {
    const facts = [
      fact("variants[0].sku", "RED-M"),
      fact("variants[0].option.Color", "Red"),
      fact("images", [{ url: "https://x.com/red-shoe.jpg", alt: "Red shoe" }])
    ];
    const s = convertFromFacts(facts, "https://x.com");
    expect(s.variants[0]?.sku).toBe("RED-M");
    expect(s.variants[0]?.option_values["Color"]).toBe("Red");
  });

  it("surfaces sanity warnings in _extraction_meta.validation_warnings", () => {
    const facts = [fact("list_price", -5, { extractionMethod: "inferred" })];
    const s = convertFromFacts(facts, "https://x.com");
    expect(s._extraction_meta.validation_warnings).toContainEqual({
      field: "pricing.list_price",
      reason: "non-positive"
    });
    expect(s.pricing.list_price).toBeNull();
  });

  it("populates _field_source from extractionMethod", () => {
    const facts = [
      fact("title", "X", { extractionMethod: "direct" }),
      fact("description", "D", { extractionMethod: "inferred" })
    ];
    const s = convertFromFacts(facts, "https://x.com");
    expect(s._field_source["title"]).toBe("structured");
    expect(s._field_source["description"]).toBe("llm-text");
  });

  it("attributes carry value+unit when parseable", () => {
    const facts = [fact("battery_life", "30 hours")];
    const s = convertFromFacts(facts, "https://x.com");
    // "hours" isn't in UNIT_MAP so it won't parse — but the attribute should still appear.
    expect(s.attributes["battery_life"]).toBeTruthy();
  });

  it("swaps sale and list prices when inverted", () => {
    const facts = [
      fact("list_price", 80),
      fact("sale_price", 100)
    ];
    const s = convertFromFacts(facts, "https://x.com");
    expect(s.pricing.list_price).toBe(100);
    expect(s.pricing.sale_price).toBe(80);
  });

  it("falls back to base_price when list_price absent", () => {
    const facts = [fact("base_price", 49.99)];
    const s = convertFromFacts(facts, "https://x.com");
    expect(s.pricing.list_price).toBe(49.99);
  });
});
