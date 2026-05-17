import { describe, it, expect } from "bun:test";
import { createLinkAdapter } from "./link-adapter.js";
import type { IngestionEnvelope } from "@aonex/ingestion-spine";

// Short, structureless HTML triggers the escalation signal (body_under_30kb +
// no_structured_data + coverage_30pct_below_50 → 3 signals ≥ 2 required).
// Inject a no-op browserFetcher stub so the real Playwright pool is never
// launched during unit tests.
const STUB_BROWSER_FETCHER = async (_url: string) => ({
  rawHtml: "<html></html>",
  finalUrl: "https://x/y",
  statusCode: 200,
  fetchDurationMs: 0
});

describe("LinkAdapter", () => {
  it("normalize yields exactly one envelope for one URL", async () => {
    const adapter = createLinkAdapter({
      fetcher: async () => ({
        url: "https://x/y",
        finalUrl: "https://x/y",
        statusCode: 200,
        contentType: "text/html",
        // Short HTML triggers escalation; browserFetcher stub returns same HTML.
        rawHtml: "<html></html>",
        cleanedText: "",
        structuredBlocks: { jsonLd: [], nextData: null, apolloState: null, initialState: null },
        captchaSignal: false,
        fetchedAt: new Date(),
        contentChecksum: "abc"
      }),
      llmExtractor: {
        extract: async () => ({
          facts: [],
          suggestedCategory: null,
          categoryConfidence: 0,
          modelName: "test-model",
          modelVersion: "test-1",
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostUsd: 0
        }),
        extractGapFill: async () => ({
          facts: [],
          suggestedCategory: null,
          categoryConfidence: 0,
          modelName: "test-model",
          modelVersion: "test-1",
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostUsd: 0
        })
      } as never,
      // Stub browser fetcher — prevents real Playwright from launching in tests.
      browserFetcher: STUB_BROWSER_FETCHER,
      // Stub DOM heuristics — keeps this test focused on envelope shape only.
      domHeuristics: () => ({ facts: [] })
    });

    const envelopes: IngestionEnvelope[] = [];
    for await (const env of adapter.normalize({ sourceRef: "https://x/y" })) {
      envelopes.push(env);
    }

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.sourceType).toBe("link_url");
    expect(envelopes[0]!.sourceExternalId).toBe("https://x/y");
    expect(envelopes[0]!.checksum).toBe("abc");
    // New escalation metadata present in rawData (escalated to browser since HTML is short).
    const rawData = envelopes[0]!.rawData as Record<string, unknown>;
    expect(rawData["escalatedTo"]).toBe("browser");
    expect(Array.isArray(rawData["escalationReasons"])).toBe(true);
    expect(rawData["costCredits"]).toBe(0);
  });
});
