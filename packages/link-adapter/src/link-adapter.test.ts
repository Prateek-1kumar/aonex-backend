import { describe, it, expect } from "bun:test";
import { createLinkAdapter } from "./link-adapter.js";
import type { IngestionEnvelope } from "@aonex/ingestion-spine";

describe("LinkAdapter", () => {
  it("normalize yields exactly one envelope for one URL", async () => {
    const adapter = createLinkAdapter({
      fetcher: async () => ({
        url: "https://x/y",
        finalUrl: "https://x/y",
        statusCode: 200,
        contentType: "text/html",
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
      } as never
    });

    const envelopes: IngestionEnvelope[] = [];
    for await (const env of adapter.normalize({ sourceRef: "https://x/y" })) {
      envelopes.push(env);
    }

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.sourceType).toBe("link_url");
    expect(envelopes[0]!.sourceExternalId).toBe("https://x/y");
    expect(envelopes[0]!.checksum).toBe("abc");
  });
});
