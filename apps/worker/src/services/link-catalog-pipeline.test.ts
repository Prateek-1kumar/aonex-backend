import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// NOTE: This is an integration test. It expects a running dev DB (docker compose up).
// If your CI doesn't run postgres, mark this test `it.skip` with a TODO.

import { cleanHtml } from "@aonex/ingestion-link-fetcher";
import { extractStructured } from "@aonex/ingestion-structured";

describe("link-catalog-pipeline (integration)", () => {
  it.skip("Decathlon: structured-first produces 10 variants, no LLM cost", async () => {
    // TODO: wire to the test-DB helper that the rest of the codebase uses.
    // Then call persistLinkCatalogPipeline and assert proposed_diff + 10 variant rows.
    const html = readFileSync(
      join(__dirname, "../../../../packages/ingestion/structured/test/fixtures/decathlon.html"),
      "utf8"
    );
    const { structuredBlocks } = cleanHtml(html);
    const { structured, coverage } = await extractStructured({
      pageUrl: "https://www.decathlon.in/p/8351755/x",
      rawHtml: html,
      structuredBlocks,
    });
    expect(coverage.complete).toBe(true);
    expect(
      structured.facts.filter((f) => /variants\[\d+\]\.option\.size/.test(f.rawKey)).length
    ).toBe(10);
  });
});
