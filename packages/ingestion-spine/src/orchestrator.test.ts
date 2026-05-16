import { describe, it, expect } from "bun:test";
import { runIngestion } from "./orchestrator.js";
import type { IngestionAdapter, IngestionEnvelope } from "./adapter.js";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";

const fakeAudit = { emit: async () => undefined };

class StubAdapter implements IngestionAdapter {
  readonly lane = "link" as const;
  constructor(private readonly factSet: ExtractedFactSet) {}
  async *normalize(): AsyncIterable<IngestionEnvelope> {
    // Not exercised by the duplicate-path smoke test — present only to
    // satisfy the IngestionAdapter contract.
    return;
  }
  async extract(): Promise<ExtractedFactSet> {
    return this.factSet;
  }
}

describe("runIngestion — duplicate path", () => {
  it("returns duplicate when persist_artifact onConflictDoNothing skips", async () => {
    // Insert into source_artifacts conflicts → returning() yields []
    // → persistArtifact returns artifactId=null → orchestrator short-circuits.
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([])
          })
        })
      })
    };
    const adapter = new StubAdapter({} as never);
    const envelope: IngestionEnvelope = {
      sourceExternalId: "https://example.com/product",
      sourceType: "link_url",
      sourceMarketplace: null,
      rawData: {},
      checksum: "abc"
    };

    const result = await runIngestion({
      db: db as never,
      audit: fakeAudit as never,
      adapter,
      envelope,
      tenantId: "t-1" as never,
      merchantId: "m-1" as never,
      requestId: "req-1",
      traceId: "tr-1"
    });

    expect(result.status).toBe("duplicate");
    if (result.status === "duplicate") {
      expect(result.checksum).toBe("abc");
    }
  });
});
