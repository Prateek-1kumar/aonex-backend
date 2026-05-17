import { describe, it, expect } from "bun:test";
import { createLinkAdapter } from "./link-adapter.js";
import type { IngestionEnvelope } from "@aonex/ingestion-spine";

// Short HTML — triggers escalation: body_under_30kb + no_structured_data +
// coverage_30pct_below_50 → 3 signals ≥ 2 required threshold.
const SHORT_STATIC_HTML = "<html><body>tiny</body></html>";

// Rich HTML — has JSON-LD + >30 KB body: 0 escalation signals → no escalation.
const RICH_STATIC_HTML = `<!DOCTYPE html><html><head><script type="application/ld+json">{"@type":"Product","name":"X","brand":"Y","offers":{"price":99}}</script></head><body>${"x".repeat(40000)}</body></html>`;

function makeFetcher(
  html: string,
  opts?: {
    jsonLd?: Record<string, unknown>[];
    nextData?: Record<string, unknown> | null;
  }
) {
  return async () => ({
    url: "https://x/y",
    finalUrl: "https://x/y",
    statusCode: 200,
    contentType: "text/html",
    rawHtml: html,
    cleanedText: "",
    structuredBlocks: {
      jsonLd: opts?.jsonLd ?? [],
      nextData: opts?.nextData ?? null,
      apolloState: null,
      initialState: null
    },
    captchaSignal: false,
    fetchedAt: new Date(),
    contentChecksum: "abc"
  });
}

const NOOP_LLM_EXTRACTOR = {
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
} as never;

describe("LinkAdapter escalation ladder", () => {
  it("does NOT escalate when static HTML is rich", async () => {
    let browserCalls = 0;
    const adapter = createLinkAdapter({
      fetcher: makeFetcher(RICH_STATIC_HTML, { jsonLd: [{ "@type": "Product", name: "X" }] }),
      llmExtractor: NOOP_LLM_EXTRACTOR,
      browserFetcher: async () => {
        browserCalls++;
        return { rawHtml: "<browser/>", finalUrl: "https://x/y", statusCode: 200, fetchDurationMs: 0 };
      },
      domHeuristics: () => ({ facts: [] })
    });

    const envelopes: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://x/y" })) envelopes.push(e);

    expect(envelopes).toHaveLength(1);
    expect((envelopes[0]!.rawData as { escalatedTo: string }).escalatedTo).toBe("static");
    expect(browserCalls).toBe(0);
  });

  it("escalates to browser when static HTML is short + structureless", async () => {
    let browserCalls = 0;
    const adapter = createLinkAdapter({
      fetcher: makeFetcher(SHORT_STATIC_HTML),
      llmExtractor: NOOP_LLM_EXTRACTOR,
      browserFetcher: async () => {
        browserCalls++;
        return {
          rawHtml: `<html><script type="application/ld+json">{"@type":"Product","name":"after-browser","brand":"Y"}</script></html>`,
          finalUrl: "https://x/y",
          statusCode: 200,
          fetchDurationMs: 50
        };
      },
      domHeuristics: () => ({ facts: [] })
    });

    const envelopes: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://x/y" })) envelopes.push(e);

    expect(envelopes).toHaveLength(1);
    expect((envelopes[0]!.rawData as { escalatedTo: string }).escalatedTo).toBe("browser");
    expect(browserCalls).toBe(1);
  });

  it("falls through to unblock when browser throws AND unblock adapter present", async () => {
    let unblockCalls = 0;
    const adapter = createLinkAdapter({
      fetcher: makeFetcher(SHORT_STATIC_HTML),
      llmExtractor: NOOP_LLM_EXTRACTOR,
      browserFetcher: async () => {
        throw new Error("browser blocked");
      },
      unblockAdapter: {
        async unblock() {
          unblockCalls++;
          return { rawHtml: "<unblocked/>", finalUrl: "https://x/y", costCredits: 5, durationMs: 100 };
        }
      },
      domHeuristics: () => ({ facts: [] })
    });

    const envelopes: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://x/y" })) envelopes.push(e);

    expect(envelopes).toHaveLength(1);
    expect((envelopes[0]!.rawData as { escalatedTo: string }).escalatedTo).toBe("unblock");
    expect((envelopes[0]!.rawData as { costCredits: number }).costCredits).toBe(5);
    expect(unblockCalls).toBe(1);
  });

  it("falls back to static (escalatedTo=static) when both browser and unblock fail", async () => {
    const adapter = createLinkAdapter({
      fetcher: makeFetcher(SHORT_STATIC_HTML),
      llmExtractor: NOOP_LLM_EXTRACTOR,
      browserFetcher: async () => {
        throw new Error("browser blocked");
      },
      unblockAdapter: {
        async unblock() {
          throw new Error("unblock failed");
        }
      },
      domHeuristics: () => ({ facts: [] })
    });

    const envelopes: IngestionEnvelope[] = [];
    for await (const e of adapter.normalize({ sourceRef: "https://x/y" })) envelopes.push(e);

    expect(envelopes).toHaveLength(1);
    expect((envelopes[0]!.rawData as { escalatedTo: string }).escalatedTo).toBe("static");
  });
});
