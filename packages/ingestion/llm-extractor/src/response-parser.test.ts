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
