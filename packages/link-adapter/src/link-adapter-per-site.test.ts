import { describe, it, expect } from "bun:test";
import { createLinkAdapter } from "./link-adapter.js";
import { InMemoryEscalationCache } from "./escalation-cache.js";
import type { IngestionEnvelope } from "@aonex/ingestion-spine";
import type { PerSiteParser } from "@aonex/per-site-parsers";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

function makeFetcher(html: string) {
  return async () => ({
    url: "https://x/y",
    finalUrl: "https://x/y",
    statusCode: 200,
    contentType: "text/html",
    rawHtml: html,
    cleanedText: "",
    structuredBlocks: { jsonLd: [], nextData: null, apolloState: null, initialState: null, metaTags: {}, linkTags: {}, microdata: [], images: [], breadcrumbs: [] },
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

function fact(rawKey: string, value: unknown, source: string, confidence = 0.9): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue: value,
    normalizedValue: null,
    unit: null,
    sourcePointer: source,
    extractionMethod: "direct",
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    confidence,
    approved: false
  };
}

describe("LinkAdapter — per-site parser integration (Layer G)", () => {
  it("runs the per-site parser when findPerSiteParser returns a match", async () => {
    const matchedParser: PerSiteParser = {
      domains: ["x"],
      priority: 100,
      fingerprint: "test@1.0",
      requiresBrowser: false,
      extract: async () => [
        fact("title", "From per-site parser", "per-site:title", 0.95),
        fact("base_price", 42, "per-site:price", 0.95)
      ]
    };

    const adapter = createLinkAdapter({
      fetcher: makeFetcher("<html><body>rich</body></html>".repeat(2000)),
      llmExtractor: STUB_LLM as never,
      browserFetcher: async () => ({
        rawHtml: "<html></html>",
        finalUrl: "https://x/y",
        statusCode: 200,
        fetchDurationMs: 0
      }),
      domHeuristics: () => ({ facts: [] }),
      findPerSiteParser: () => matchedParser,
      cache: new InMemoryEscalationCache()
    });

    // Normalize first to populate the cache
    const envelopes: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://x/y" })) envelopes.push(e);
    const result = await adapter.extract(envelopes[0]!);

    expect(result.facts.find((f: ExtractedFact) => f.rawKey === "title")?.extractedValue).toBe("From per-site parser");
    expect(result.facts.find((f: ExtractedFact) => f.rawKey === "base_price")?.extractedValue).toBe(42);
  });

  it("per-site facts win over generic on rawKey collisions", async () => {
    const matchedParser: PerSiteParser = {
      domains: ["x"],
      priority: 100,
      fingerprint: "test@1.0",
      requiresBrowser: false,
      extract: async () => [fact("title", "Per-site wins", "per-site", 0.95)]
    };

    const adapter = createLinkAdapter({
      fetcher: makeFetcher("<html><body>" + "x".repeat(40000) + "</body></html>"),
      llmExtractor: STUB_LLM as never,
      browserFetcher: async () => ({ rawHtml: "", finalUrl: "https://x/y", statusCode: 200, fetchDurationMs: 0 }),
      domHeuristics: () => ({ facts: [fact("title", "Generic loses", "dom_heuristic:title", 0.85)] }),
      findPerSiteParser: () => matchedParser,
      cache: new InMemoryEscalationCache()
    });

    const envs: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://x/y" })) envs.push(e);
    const result = await adapter.extract(envs[0]!);

    const titleFacts = result.facts.filter((f: ExtractedFact) => f.rawKey === "title");
    expect(titleFacts).toHaveLength(1);
    expect(titleFacts[0]!.extractedValue).toBe("Per-site wins");
  });

  it("generic facts fill gaps not covered by per-site", async () => {
    const matchedParser: PerSiteParser = {
      domains: ["x"],
      priority: 100,
      fingerprint: "test@1.0",
      requiresBrowser: false,
      extract: async () => [fact("title", "Per-site title", "per-site", 0.95)]
    };

    const adapter = createLinkAdapter({
      fetcher: makeFetcher("<html><body>" + "x".repeat(40000) + "</body></html>"),
      llmExtractor: STUB_LLM as never,
      browserFetcher: async () => ({ rawHtml: "", finalUrl: "https://x/y", statusCode: 200, fetchDurationMs: 0 }),
      domHeuristics: () => ({
        facts: [
          fact("title", "Generic title (loses)", "dom:title", 0.85),
          fact("base_price", 99, "dom:price", 0.85)
        ]
      }),
      findPerSiteParser: () => matchedParser,
      cache: new InMemoryEscalationCache()
    });

    const envs: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://x/y" })) envs.push(e);
    const result = await adapter.extract(envs[0]!);

    expect(result.facts.find((f: ExtractedFact) => f.rawKey === "title")?.extractedValue).toBe("Per-site title");
    expect(result.facts.find((f: ExtractedFact) => f.rawKey === "base_price")?.extractedValue).toBe(99);
  });

  it("falls back to generic when no per-site parser matches", async () => {
    const adapter = createLinkAdapter({
      fetcher: makeFetcher("<html><body>" + "x".repeat(40000) + "</body></html>"),
      llmExtractor: STUB_LLM as never,
      browserFetcher: async () => ({ rawHtml: "", finalUrl: "https://x/y", statusCode: 200, fetchDurationMs: 0 }),
      domHeuristics: () => ({ facts: [fact("title", "DOM only", "dom:title", 0.85)] }),
      findPerSiteParser: () => null,
      cache: new InMemoryEscalationCache()
    });
    const envs: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://x/y" })) envs.push(e);
    const result = await adapter.extract(envs[0]!);
    expect(result.facts.find((f: ExtractedFact) => f.rawKey === "title")?.extractedValue).toBe("DOM only");
  });

  it("per-site parser exception falls through to generic without crashing", async () => {
    const failingParser: PerSiteParser = {
      domains: ["x"],
      priority: 100,
      fingerprint: "test@1.0",
      requiresBrowser: false,
      extract: async () => { throw new Error("parser blew up"); }
    };

    const adapter = createLinkAdapter({
      fetcher: makeFetcher("<html><body>" + "x".repeat(40000) + "</body></html>"),
      llmExtractor: STUB_LLM as never,
      browserFetcher: async () => ({ rawHtml: "", finalUrl: "https://x/y", statusCode: 200, fetchDurationMs: 0 }),
      domHeuristics: () => ({ facts: [fact("title", "Generic survived", "dom:title", 0.85)] }),
      findPerSiteParser: () => failingParser,
      cache: new InMemoryEscalationCache()
    });
    const envs: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://x/y" })) envs.push(e);
    const result = await adapter.extract(envs[0]!);
    expect(result.facts.find((f: ExtractedFact) => f.rawKey === "title")?.extractedValue).toBe("Generic survived");
  });

  it("calls LLM gap-fill when base facts are non-empty (always-on)", async () => {
    // Track invocations manually (bun:test doesn't have vi.fn()).
    let extractCalls = 0;
    let gapFillCalls = 0;
    let lastGapFillArgs: { gaps: string[]; structuredFactsCount: number } | null = null;

    const trackingLLM = {
      extract: async () => {
        extractCalls++;
        return {
          facts: [],
          suggestedCategory: null,
          categoryConfidence: 0,
          modelName: "t",
          modelVersion: "t",
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostUsd: 0
        };
      },
      extractGapFill: async (
        _cleanedText: string,
        _url: string,
        _artifactId: never,
        options: { gaps: string[]; structuredFacts: unknown[] }
      ) => {
        gapFillCalls++;
        lastGapFillArgs = {
          gaps: options.gaps,
          structuredFactsCount: options.structuredFacts.length
        };
        return {
          facts: [
            {
              rawKey: "images",
              extractedValue: [],
              normalizedValue: [{ url: "https://x.com/h.jpg", altText: null }],
              unit: null,
              sourcePointer: "",
              extractionMethod: "inferred",
              canonicalPath: null,
              mappingMethod: null,
              mappingCandidates: null,
              sourceAlternatives: null,
              confidence: 0.8,
              approved: false
            } as ExtractedFact
          ],
          suggestedCategory: null,
          categoryConfidence: 0,
          modelName: "t",
          modelVersion: "t",
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostUsd: 0
        };
      }
    };

    // Per-site parser produces a non-empty baseFacts set with title + base_price.
    const matchedParser: PerSiteParser = {
      domains: ["x"],
      priority: 100,
      fingerprint: "test@1.0",
      requiresBrowser: false,
      extract: async () => [
        fact("title", "Anchor title", "per-site:title", 0.95),
        fact("base_price", 42, "per-site:price", 0.95)
      ]
    };

    const adapter = createLinkAdapter({
      fetcher: makeFetcher("<html><body>" + "x".repeat(40000) + "</body></html>"),
      llmExtractor: trackingLLM as never,
      browserFetcher: async () => ({ rawHtml: "", finalUrl: "https://x/y", statusCode: 200, fetchDurationMs: 0 }),
      domHeuristics: () => ({ facts: [] }),
      findPerSiteParser: () => matchedParser,
      cache: new InMemoryEscalationCache()
    });

    const envs: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://x/y" })) envs.push(e);
    const result = await adapter.extract(envs[0]!);

    // The legacy `extract` path must NOT be called — gap-fill replaces it.
    expect(extractCalls).toBe(0);
    // The new gap-fill path MUST be called even though baseFacts is non-empty.
    expect(gapFillCalls).toBe(1);
    expect(lastGapFillArgs).not.toBeNull();
    // Gaps should include images (not produced by per-site), and exclude title/base_price.
    expect(lastGapFillArgs!.gaps).toContain("images");
    expect(lastGapFillArgs!.gaps).not.toContain("title");
    expect(lastGapFillArgs!.gaps).not.toContain("base_price");
    // Anchored on the 2 per-site facts.
    expect(lastGapFillArgs!.structuredFactsCount).toBe(2);
    // The LLM-supplied images fact appears in the merged output.
    expect(result.facts.find((f: ExtractedFact) => f.rawKey === "images")).toBeDefined();
  });
});
