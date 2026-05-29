import { test, expect } from "bun:test";
import { createLlmCallModel } from "./call-model-adapter.js";
import type { LLMProductExtractor } from "./extractor.js";

const fakeExtractor = {
  extractGapFill: async (_text: string, _url: string, _id: string, opts: { gaps: string[] }) => ({
    facts: opts.gaps.map((g) => ({
      rawKey: g,
      canonicalPath: null,
      extractedValue: `value-of-${g}`,
      normalizedValue: `value-of-${g}`,
      unit: null,
      sourcePointer: "llm",
      extractionMethod: "direct" as const,
      confidence: 0.85,
      mappingMethod: null,
      mappingCandidates: null,
      sourceAlternatives: null,
      approved: false,
    })),
    estimatedCostUsd: 0.001,
  }),
} as unknown as LLMProductExtractor;

const baseHints = {
  jsonLd: [] as Record<string, unknown>[],
  metaTags: {} as Record<string, string>,
  microdata: [] as { prop: string; value: string }[],
  rawImageUrls: [] as string[],
  nextDataProductSubtree: null as unknown,
};

test("adapter asks LLM only for the requested schema fields and maps to {value, rawConfidence}", async () => {
  const callModel = createLlmCallModel({
    llmExtractor: fakeExtractor,
    baseFacts: [],
    structuredHints: baseHints,
    finalUrl: "https://x",
    artifactId: "art-1",
  });
  const out = await callModel(["brand", "base_price"], "page text");
  expect(Object.keys(out).sort()).toEqual(["base_price", "brand"]);
  expect(out["brand"]?.value).toBe("value-of-brand");
  expect(out["brand"]?.rawConfidence).toBe(0.85);
});

test("adapter short-circuits on empty schemaFields (no LLM call)", async () => {
  let called = false;
  const tracker = {
    extractGapFill: async () => {
      called = true;
      return { facts: [], estimatedCostUsd: 0 };
    },
  } as unknown as LLMProductExtractor;
  const callModel = createLlmCallModel({
    llmExtractor: tracker,
    baseFacts: [],
    structuredHints: baseHints,
    finalUrl: "https://x",
    artifactId: "art-2",
  });
  const out = await callModel([], "any text");
  expect(called).toBe(false);
  expect(out).toEqual({});
});

test("adapter invokes onCost callback when estimatedCostUsd is returned", async () => {
  let recorded = 0;
  const callModel = createLlmCallModel({
    llmExtractor: fakeExtractor,
    baseFacts: [],
    structuredHints: baseHints,
    finalUrl: "https://x",
    artifactId: "art-3",
    onCost: (usd) => { recorded = usd; },
  });
  await callModel(["title"], "t");
  expect(recorded).toBe(0.001);
});
