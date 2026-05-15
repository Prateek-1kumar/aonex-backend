import { describe, it, expect } from "bun:test";
import { mergeParserOutputs } from "./merge.js";
import type { ParserOutput } from "./types.js";

function mk(kind: ParserOutput["kind"], rawKey: string, value: unknown, confidence: number): ParserOutput {
  return {
    kind,
    facts: [
      {
        rawKey,
        canonicalPath: null,
        extractedValue: value,
        normalizedValue: value,
        unit: null,
        sourcePointer: `${kind}:${rawKey}`,
        extractionMethod: "direct",
        confidence,
        mappingMethod: null,
        mappingCandidates: null,
        sourceAlternatives: null,
        approved: false,
      },
    ],
    baselineConfidence: confidence,
  };
}

describe("mergeParserOutputs", () => {
  it("keeps highest-confidence fact per rawKey", () => {
    const ld = mk("json_ld", "title", "JSON-LD title", 0.95);
    const og = mk("opengraph", "title", "OG title", 0.65);
    const merged = mergeParserOutputs([ld, og]);
    const title = merged.facts.find((f) => f.rawKey === "title");
    expect(title?.extractedValue).toBe("JSON-LD title");
    expect(title?.confidence).toBeCloseTo(0.95);
  });

  it("preserves losing values + sources in sourceAlternatives", () => {
    const ld = mk("json_ld", "title", "Ekiden One", 0.95);
    const og = mk("opengraph", "title", "Kalenji Run 100", 0.65);
    const merged = mergeParserOutputs([ld, og]);
    const title = merged.facts.find((f) => f.rawKey === "title")!;
    expect(title.sourceAlternatives).toEqual([
      { value: "Kalenji Run 100", sourcePointer: "opengraph:title", confidence: 0.65 },
    ]);
  });

  it("drops alts whose value matches the winner (no false conflict)", () => {
    const ld = mk("json_ld", "title", "Ekiden One", 0.95);
    const og = mk("opengraph", "title", "ekiden one", 0.65); // same, different case
    const merged = mergeParserOutputs([ld, og]);
    const title = merged.facts.find((f) => f.rawKey === "title")!;
    expect(title.sourceAlternatives).toBeNull();
  });

  describe("field-level precedence", () => {
    it("NEXT_DATA wins category over JSON-LD even with lower baseline confidence", () => {
      const ld = mk("json_ld", "productType", "Home/Generic", 0.95);
      const nd = mk("next_data", "productType", "home/electronics/phones", 0.85);
      const merged = mergeParserOutputs([ld, nd]);
      const cat = merged.facts.find((f) => f.rawKey === "productType")!;
      expect(cat.extractedValue).toBe("home/electronics/phones");
    });

    it("NEXT_DATA wins inventory_quantity over JSON-LD", () => {
      const ld = mk("json_ld", "variants[0].inventory_quantity", 0, 0.95);
      const nd = mk("next_data", "variants[0].inventory_quantity", 12, 0.85);
      const merged = mergeParserOutputs([ld, nd]);
      const inv = merged.facts.find((f) =>
        f.rawKey === "variants[0].inventory_quantity"
      )!;
      expect(inv.extractedValue).toBe(12);
    });

    it("JSON-LD wins material (attribute family) over NEXT_DATA", () => {
      const ld = mk("json_ld", "material", "Linen", 0.95);
      const nd = mk("next_data", "material", "Cotton", 0.85);
      const merged = mergeParserOutputs([ld, nd]);
      expect(merged.facts.find((f) => f.rawKey === "material")?.extractedValue).toBe(
        "Linen"
      );
    });

    it("JSON-LD still wins title (text family) over NEXT_DATA", () => {
      const ld = mk("json_ld", "title", "Canonical Title", 0.95);
      const nd = mk("next_data", "title", "Marketing Title", 0.85);
      const merged = mergeParserOutputs([ld, nd]);
      expect(merged.facts.find((f) => f.rawKey === "title")?.extractedValue).toBe(
        "Canonical Title"
      );
    });

    it("Shopify probe wins variants (sku) over JSON-LD ProductGroup", () => {
      const ld = mk("json_ld", "variants[0].sku", "JSONLD-SKU", 0.95);
      const sp = mk("shopify_probe", "variants[0].sku", "SHOPIFY-SKU", 0.95);
      const merged = mergeParserOutputs([ld, sp]);
      expect(
        merged.facts.find((f) => f.rawKey === "variants[0].sku")?.extractedValue
      ).toBe("SHOPIFY-SKU");
    });
  });
});
