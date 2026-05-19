import { describe, it, expect } from "bun:test";
import { convertToExtractedFacts, parseLLMResponse } from "./response-parser.js";

describe("response-parser", () => {
  it("uses LLM self-reported confidence per field (not hardcoded constants)", () => {
    const raw = JSON.stringify({
      title: "T",
      brand: "B",
      base_price: 9.99,
      currency: "USD",
      _field_confidence: {
        title: 0.7,
        brand: 0.4,
        base_price: 0.95,
        currency: 0.95,
      },
    });
    const parsed = parseLLMResponse(raw);
    expect(parsed).not.toBeNull();
    const facts = convertToExtractedFacts(parsed!, "https://x.com/p");
    const c = (k: string) => facts.find((f) => f.rawKey === k)?.confidence;
    expect(c("title")).toBeCloseTo(0.7, 2);
    expect(c("brand" /* or vendor */)).toBeCloseTo(0.4, 2);
  });

  it("caps any reported confidence at 0.85 (HLD §14.2)", () => {
    const raw = JSON.stringify({
      title: "T",
      _field_confidence: { title: 0.99 },
    });
    const facts = convertToExtractedFacts(parseLLMResponse(raw)!, "u");
    expect(facts.find((f) => f.rawKey === "title")?.confidence).toBeLessThanOrEqual(0.85);
  });

  it("defaults to 0.5 when LLM omits _field_confidence for a field", () => {
    const raw = JSON.stringify({ title: "T" });
    const facts = convertToExtractedFacts(parseLLMResponse(raw)!, "u");
    expect(facts.find((f) => f.rawKey === "title")?.confidence).toBeCloseTo(0.5, 2);
  });

  it("marks all facts as extractionMethod='inferred'", () => {
    const raw = JSON.stringify({ title: "T" });
    const facts = convertToExtractedFacts(parseLLMResponse(raw)!, "u");
    for (const f of facts) expect(f.extractionMethod).toBe("inferred");
  });
});

describe("convertToExtractedFacts — Phase 2 rich schema", () => {
  it("emits list_price / sale_price facts from pricing object", () => {
    const facts = convertToExtractedFacts({
      title: "X",
      pricing: { list_price: 100, sale_price: 80, currency: "USD" }
    } as never, "https://x.com");
    expect(facts.find((f) => f.rawKey === "list_price")?.normalizedValue).toBe(100);
    expect(facts.find((f) => f.rawKey === "sale_price")?.normalizedValue).toBe(80);
  });

  it("emits rating_average / rating_count from ratings object", () => {
    const facts = convertToExtractedFacts({ title: "X", ratings: { average: 4.5, count: 1234 } } as never, "https://x.com");
    expect(facts.find((f) => f.rawKey === "rating_average")?.normalizedValue).toBe(4.5);
    expect(facts.find((f) => f.rawKey === "rating_count")?.normalizedValue).toBe(1234);
  });

  it("emits highlights and breadcrumbs facts", () => {
    const facts = convertToExtractedFacts({
      title: "X",
      highlights: ["A","B"],
      breadcrumbs: ["Home","Cat"]
    } as never, "https://x.com");
    expect(facts.find((f) => f.rawKey === "highlights")?.normalizedValue).toEqual(["A","B"]);
    expect(facts.find((f) => f.rawKey === "breadcrumbs")?.normalizedValue).toEqual(["Home","Cat"]);
  });

  it("emits weight fact with unit when shipping.weight is present", () => {
    const facts = convertToExtractedFacts({
      title: "X",
      shipping: { weight: { value: 1.5, unit: "kg" } }
    } as never, "https://x.com");
    const w = facts.find((f) => f.rawKey === "weight");
    expect(w?.normalizedValue).toEqual({ value: 1.5, unit: "kg" });
    expect(w?.unit).toBe("kg");
  });

  it("handles typed attribute (value+unit object)", () => {
    const facts = convertToExtractedFacts({
      title: "X",
      attributes: { battery_life: { value: 30, unit: "h", source: "structured" } }
    } as never, "https://x.com");
    const f = facts.find((f) => f.rawKey === "battery_life");
    expect(f?.normalizedValue).toBe(30);
    expect(f?.unit).toBe("h");
  });
});
