import { test, expect } from "bun:test";
import type { IModelProvider, ModelCompletionResult } from "@aonex/ingestion-llm-extractor";
import { generateEnrichmentProposal } from "./enrich.js";
import type { ProductSnapshot } from "./types.js";

function fakeProvider(content: string, reasoning?: string): IModelProvider {
  return {
    providerName: "fake",
    async chatCompletion(): Promise<ModelCompletionResult> {
      const r: ModelCompletionResult = {
        content,
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        model: "fake-model",
        finishReason: "stop",
      };
      if (reasoning) r.reasoning = reasoning;
      return r;
    },
    estimateCost() {
      return 0.001;
    },
  };
}

const jeans: ProductSnapshot = {
  productId: "p1",
  family: "apparel",
  current: { title: "Slim Fit Jeans", category_path: "Jeans" },
  facts: { hasPrice: true, hasCurrency: true, hasIdentifier: false, hasTitle: true },
  title: "The Indian Garage Co Slim Fit Jeans",
  categoryPath: "clothing/men/jeans",
  brand: "The Indian Garage Co",
};

test("proposal: fills apparel fields, flags bad enum, drops protected, scores up, discovers candidate", async () => {
  const content = JSON.stringify({
    fields: {
      fit: { value: "Slim", confidence: 0.9, reasoning: "title says slim" },
      fabric: { value: "98% Cotton, 2% Elastane", confidence: 0.7 },
      wash: { value: "Neon Purple", confidence: 0.5 }, // not in enum -> flagged
      category_path: {
        value: ["Home", "Clothing", "Men Clothing", "Jeans", "The Indian Garage Co Jeans"],
        confidence: 0.8,
      },
      base_price: { value: 1999, confidence: 0.9 }, // protected -> never in schema
      meta_title: { value: "Slim Fit Jeans - The Indian Garage Co", confidence: 0.8 },
    },
    candidates: [
      { key: "distressing", label: "Distressing", dataType: "string", value: "None", reasoning: "matters for jeans" },
      { key: "base_price", value: 1999, reasoning: "should be ignored" }, // protected -> dropped
    ],
  });

  const proposal = await generateEnrichmentProposal(jeans, {
    provider: fakeProvider(content, "thinking..."),
    model: "x",
  });

  expect(proposal.archetype).toBe("apparel");
  const byCode = new Map(proposal.fields.map((f) => [f.attributeCode, f]));
  expect(byCode.get("fit")?.valid).toBe(true);
  expect(byCode.get("fit")?.action).toBe("fill");
  expect(byCode.has("base_price")).toBe(false); // protected never proposed
  expect(byCode.get("wash")?.valid).toBe(false); // bad enum flagged, not dropped
  expect(byCode.get("category_path")?.action).toBe("improve"); // had a prior value
  expect(proposal.scoreAfter.completeness).toBeGreaterThan(proposal.scoreBefore.completeness);
  expect(proposal.reasoning).toBe("thinking...");

  const candKeys = new Set(proposal.candidates.map((c) => c.key));
  expect(candKeys.has("distressing")).toBe(true);
  expect(candKeys.has("base_price")).toBe(false); // protected candidate dropped
});

test("malformed JSON surfaces EnrichmentParseError", async () => {
  let caught: unknown;
  try {
    await generateEnrichmentProposal(jeans, { provider: fakeProvider("not json at all"), model: "x" });
  } catch (e) {
    caught = e;
  }
  expect((caught as Error | undefined)?.name).toBe("EnrichmentParseError");
});
