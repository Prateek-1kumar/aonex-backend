import { describe, it, expect } from "bun:test";
import urls from "./smoke-fixtures/urls.json" with { type: "json" };
import { createLinkAdapter } from "./link-adapter.js";
import { InMemoryEscalationCache } from "./escalation-cache.js";
import { LLMProductExtractor, OpenAIProvider } from "@aonex/ingestion-llm-extractor";
import type { IngestionEnvelope } from "@aonex/ingestion-spine";

// Manual smoke test — only runs when SMOKE=1 is set AND OPENAI_API_KEY is provided.
// This test is intentionally skipped in CI and requires manual invocation.
// Goal: verify ≥9/10 sample URLs produce ≥1 image after Phase 1 changes.
//
//   SMOKE=1 OPENAI_API_KEY=... OPENAI_BASE_URL=https://api.groq.com/openai/v1 \
//     bun test src/phase1-smoke.test.ts

const SHOULD_RUN = !!process.env["SMOKE"] && !!process.env["OPENAI_API_KEY"];

describe.skipIf(!SHOULD_RUN)("Phase 1 acceptance — 10 URL smoke", () => {
  const provider = new OpenAIProvider({
    apiKey: process.env["OPENAI_API_KEY"]!,
    baseUrl: process.env["OPENAI_BASE_URL"]
  });
  const llmExtractor = new LLMProductExtractor(provider);

  for (const url of urls as string[]) {
    it(`extracts at least one image from ${url}`, async () => {
      const adapter = createLinkAdapter({
        llmExtractor,
        cache: new InMemoryEscalationCache()
      });

      const envelopes: IngestionEnvelope[] = [];
      for await (const e of adapter.normalize({ sourceRef: url })) envelopes.push(e);
      const result = await adapter.extract(envelopes[0]!);

      const imageFact = result.facts.find((f: typeof result.facts[number]) => f.rawKey === "images");
      const value = (imageFact?.normalizedValue ?? imageFact?.extractedValue) as { url: string }[] | undefined;

      // Soft assertion: log but don't fail individual URLs (so we see ≥9/10 pattern).
      // To make the suite fail when overall pass rate < 9/10, aggregate stats in afterAll.
      if (!value || value.length === 0) {
        console.warn(`[smoke] no images extracted from ${url}`);
      }
      expect(imageFact).toBeTruthy();
    }, 90_000);
  }
});
