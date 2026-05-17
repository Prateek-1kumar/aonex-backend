import { describe, it, expect } from "bun:test";
import { crossValidate } from "./cross-validator.js";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

function makeFact(rawKey: string, value: unknown, sourcePointer: string, confidence: number): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue: value,
    normalizedValue: null,
    unit: null,
    sourcePointer,
    extractionMethod: "direct",
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    confidence,
    approved: false
  };
}

describe("crossValidate", () => {
  it("flags JSON-LD price that disagrees with OpenGraph price", () => {
    const result = crossValidate({
      jsonLdFacts: [makeFact("base_price", 99, "json_ld.offers.price", 0.95)],
      openGraphFacts: [makeFact("base_price", 89, "og.product:price:amount", 0.70)],
      domFacts: []
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.field).toBe("base_price");
    expect(result.conflicts[0]!.sources).toHaveLength(2);
  });

  it("agrees and boosts confidence when prices match", () => {
    const result = crossValidate({
      jsonLdFacts: [makeFact("base_price", 99, "json_ld.offers.price", 0.95)],
      openGraphFacts: [makeFact("base_price", 99, "og.product:price:amount", 0.70)],
      domFacts: []
    });
    expect(result.conflicts).toEqual([]);
    const priceFact = result.agreedFacts.find((f) => f.rawKey === "base_price");
    expect(priceFact?.confidence).toBeGreaterThan(0.95);
  });

  it("normalizes string comparison (trim + lowercase) for titles", () => {
    const result = crossValidate({
      jsonLdFacts: [makeFact("title", "Aonami Pro Drill", "json_ld.name", 0.95)],
      openGraphFacts: [makeFact("title", "  aonami pro drill  ", "og.title", 0.65)],
      domFacts: []
    });
    expect(result.conflicts).toEqual([]);
  });

  it("keeps single-source facts as-is (no conflict, no boost)", () => {
    const jsonLdFact = makeFact("brand", "Aonami", "json_ld.brand.name", 0.95);
    const result = crossValidate({
      jsonLdFacts: [jsonLdFact],
      openGraphFacts: [],
      domFacts: []
    });
    expect(result.conflicts).toEqual([]);
    expect(result.agreedFacts).toContainEqual(jsonLdFact);
  });

  it("on conflict, keeps highest-confidence source with confidence penalty", () => {
    const result = crossValidate({
      jsonLdFacts: [makeFact("title", "Title A", "json_ld.name", 0.95)],
      openGraphFacts: [makeFact("title", "Title B", "og.title", 0.65)],
      domFacts: []
    });
    expect(result.conflicts).toHaveLength(1);
    const winnerFact = result.agreedFacts.find((f) => f.rawKey === "title");
    expect(winnerFact?.extractedValue).toBe("Title A");
    expect(winnerFact?.confidence).toBeLessThan(0.95);
    expect(winnerFact?.confidence).toBeGreaterThanOrEqual(0.80);
  });

  it("carries forward non-comparable facts from all sources unchanged", () => {
    const customFact = makeFact("color", "Red", "json_ld.color", 0.70);
    const result = crossValidate({
      jsonLdFacts: [customFact],
      openGraphFacts: [],
      domFacts: []
    });
    expect(result.agreedFacts).toContainEqual(customFact);
  });
});
