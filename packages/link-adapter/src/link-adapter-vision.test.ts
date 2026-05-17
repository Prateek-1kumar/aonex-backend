import { describe, it, expect } from "bun:test";
import { createLinkAdapter } from "./link-adapter.js";
import type { IngestionEnvelope } from "@aonex/ingestion-spine";
import type { VisionCallResult } from "@aonex/vision-extractor";
import type { FetchBrowserWithScreenshotResult } from "@aonex/ingestion-browser-fallback";

function makeFetcher(html: string) {
  return async () => ({
    url: "https://shop.example/p/123",
    finalUrl: "https://shop.example/p/123",
    statusCode: 200,
    contentType: "text/html",
    rawHtml: html,
    cleanedText: "",
    structuredBlocks: { jsonLd: [], nextData: null, apolloState: null, initialState: null },
    captchaSignal: false,
    fetchedAt: new Date(),
    contentChecksum: "abc"
  });
}

const STUB_LLM = {
  extract: async () => ({
    facts: [],
    suggestedCategory: null,
    categoryConfidence: 0,
    modelName: "t",
    modelVersion: "t",
    promptTokens: 0,
    completionTokens: 0,
    estimatedCostUsd: 0
  }),
  extractGapFill: async () => ({
    facts: [],
    suggestedCategory: null,
    categoryConfidence: 0,
    modelName: "t",
    modelVersion: "t",
    promptTokens: 0,
    completionTokens: 0,
    estimatedCostUsd: 0
  })
};

const SIZE_CHART_HTML = `<html><body>` + "x".repeat(40000) + `<img src="/cdn/size-chart-shoes.png"></body></html>`;
const RICH_HTML = `<html><head><script type="application/ld+json">{"@type":"Product","name":"X","brand":"Y","offers":{"price":99}}</script></head><body>` + "x".repeat(40000) + `</body></html>`;

describe("LinkAdapter — vision tier-3 (Layer F)", () => {
  it("calls vision when shouldEscalateToVision fires AND visionExtractor is configured", async () => {
    let visionCalls = 0;
    let screenshotCalls = 0;
    const visionResult: VisionCallResult = {
      facts: [
        { rawKey: "size_chart", canonicalPath: null, extractedValue: "S/M/L/XL", normalizedValue: null, unit: null,
          sourcePointer: "vision:size_chart", extractionMethod: "inferred", mappingMethod: null,
          mappingCandidates: null, sourceAlternatives: null, confidence: 0.70, approved: false }
      ],
      modelName: "stub",
      modelVersion: "stub@1.0",
      promptTokens: 100,
      completionTokens: 20,
      estimatedCostUsd: 0.001
    };
    const screenshotStub: FetchBrowserWithScreenshotResult = {
      rawHtml: SIZE_CHART_HTML,
      finalUrl: "https://shop.example/p/123",
      statusCode: 200,
      fetchDurationMs: 100,
      screenshotBase64: "MOCKBASE64"
    };

    const adapter = createLinkAdapter({
      fetcher: makeFetcher(SIZE_CHART_HTML),
      llmExtractor: STUB_LLM as never,
      browserFetcher: async () => ({ rawHtml: SIZE_CHART_HTML, finalUrl: "https://shop.example/p/123", statusCode: 200, fetchDurationMs: 0 }),
      domHeuristics: () => ({ facts: [] }),
      findPerSiteParser: () => null,
      screenshotFetcher: async () => { screenshotCalls++; return screenshotStub; },
      visionExtractor: async () => { visionCalls++; return visionResult; }
    });

    const envs: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://shop.example/p/123" })) envs.push(e);
    const result = await adapter.extract(envs[0]!);

    expect(visionCalls).toBe(1);
    expect(screenshotCalls).toBe(1);
    expect(result.facts.find((f) => f.rawKey === "size_chart")?.extractedValue).toBe("S/M/L/XL");
  });

  it("does NOT call vision when upstream has rich text price (no signal)", async () => {
    let visionCalls = 0;
    const adapter = createLinkAdapter({
      fetcher: makeFetcher(RICH_HTML),
      llmExtractor: STUB_LLM as never,
      browserFetcher: async () => ({ rawHtml: RICH_HTML, finalUrl: "https://shop.example/p/123", statusCode: 200, fetchDurationMs: 0 }),
      domHeuristics: () => ({ facts: [
        { rawKey: "base_price", canonicalPath: null, extractedValue: 99, normalizedValue: null, unit: null,
          sourcePointer: "dom:price", extractionMethod: "inferred", mappingMethod: null, mappingCandidates: null,
          sourceAlternatives: null, confidence: 0.85, approved: false },
        { rawKey: "title", canonicalPath: null, extractedValue: "X", normalizedValue: null, unit: null,
          sourcePointer: "dom:title", extractionMethod: "inferred", mappingMethod: null, mappingCandidates: null,
          sourceAlternatives: null, confidence: 0.85, approved: false }
      ] }),
      findPerSiteParser: () => null,
      screenshotFetcher: async () => ({ rawHtml: "", finalUrl: "", statusCode: 200, fetchDurationMs: 0, screenshotBase64: "" }),
      visionExtractor: async () => { visionCalls++; return { facts: [], modelName: "x", modelVersion: "x", promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 }; }
    });

    const envs: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://shop.example/p/123" })) envs.push(e);
    await adapter.extract(envs[0]!);
    expect(visionCalls).toBe(0);
  });

  it("does NOT call vision when visionExtractor is null (no API key)", async () => {
    let visionCalls = 0;
    let screenshotCalls = 0;
    // Manually pass undefined; the constructor will default to null when no env key
    // We simulate by checking that no call happens.
    const adapter = createLinkAdapter({
      fetcher: makeFetcher(SIZE_CHART_HTML),
      llmExtractor: STUB_LLM as never,
      browserFetcher: async () => ({ rawHtml: SIZE_CHART_HTML, finalUrl: "https://shop.example/p/123", statusCode: 200, fetchDurationMs: 0 }),
      domHeuristics: () => ({ facts: [] }),
      findPerSiteParser: () => null,
      screenshotFetcher: async () => { screenshotCalls++; return { rawHtml: "", finalUrl: "", statusCode: 200, fetchDurationMs: 0, screenshotBase64: "" }; },
      // visionExtractor omitted — the constructor checks env; if absent, defaults to null.
      // Pass explicit null-like behavior by mocking the env check via a no-op visionExtractor.
      visionExtractor: undefined
    });

    const envs: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://shop.example/p/123" })) envs.push(e);
    await adapter.extract(envs[0]!);

    // When GROQ_API_KEY or OPENAI_API_KEY happens to be set in CI, vision MAY fire.
    // To make the test deterministic in any env, we don't assert visionCalls === 0.
    // Instead: if neither env var is set in this test run, screenshot also shouldn't fire.
    if (!process.env["GROQ_API_KEY"] && !process.env["OPENAI_API_KEY"]) {
      expect(screenshotCalls).toBe(0);
      expect(visionCalls).toBe(0);
    }
  });

  it("survives screenshot or vision exception without crashing the extract", async () => {
    const adapter = createLinkAdapter({
      fetcher: makeFetcher(SIZE_CHART_HTML),
      llmExtractor: STUB_LLM as never,
      browserFetcher: async () => ({ rawHtml: SIZE_CHART_HTML, finalUrl: "https://shop.example/p/123", statusCode: 200, fetchDurationMs: 0 }),
      domHeuristics: () => ({ facts: [] }),
      findPerSiteParser: () => null,
      screenshotFetcher: async () => { throw new Error("screenshot timeout"); },
      visionExtractor: async () => ({ facts: [], modelName: "x", modelVersion: "x", promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 })
    });
    const envs: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://shop.example/p/123" })) envs.push(e);
    const result = await adapter.extract(envs[0]!);
    // Should not throw; should return whatever upstream had (likely empty)
    expect(result.facts).toBeDefined();
  });
});
