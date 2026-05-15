import { describe, it, expect } from "bun:test";
import { LLMProductExtractor } from "./extractor.js";

class FakeProvider {
  estimateCost() { return 0; }
  async chatCompletion(req: { messages: Array<{ content: string }> }) {
    return {
      model: "fake",
      content: JSON.stringify({
        attributes: { material: "100% Cotton", fit: "Oversized" },
        _field_confidence: { material: 0.8, fit: 0.75 },
      }),
      usage: { promptTokens: 100, completionTokens: 20 },
    };
  }
}

describe("LLMProductExtractor.extractGapFill", () => {
  it("returns only the requested gap fields with self-reported confidence", async () => {
    const ex = new LLMProductExtractor(new FakeProvider() as never);
    const out = await ex.extractGapFill("body", "https://x.com/p", "art-1" as never, {
      model: "fake",
      maxTokens: 500,
      temperature: 0,
      gaps: ["material", "fit"],
      structuredFacts: [],
    });
    expect(out.facts.map((f) => f.rawKey).sort()).toEqual(["fit", "material"]);
    expect(out.facts.find((f) => f.rawKey === "material")?.confidence).toBeCloseTo(0.8, 2);
  });
});
