import { describe, it, expect } from "bun:test";
import { runExtract } from "./extract.js";
import type { IngestionAdapter, IngestionEnvelope } from "../adapter.js";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";

// Mock adapter that yields one envelope and one fact set.
class MockAdapter implements IngestionAdapter {
  readonly lane = "link" as const;
  private readonly envelope: IngestionEnvelope;
  private readonly factSet: ExtractedFactSet;

  constructor(envelope: IngestionEnvelope, factSet: ExtractedFactSet) {
    this.envelope = envelope;
    this.factSet = factSet;
  }

  async *normalize(): AsyncIterable<IngestionEnvelope> {
    yield this.envelope;
  }

  // Mock extractor entry point exposed for the stage
  async extract(_envelope: IngestionEnvelope): Promise<ExtractedFactSet> {
    return this.factSet;
  }
}

const envelope: IngestionEnvelope = {
  sourceExternalId: "https://example.com/p/1",
  sourceType: "link_url",
  sourceMarketplace: null,
  rawData: {},
  checksum: "abc"
};

const factSet: ExtractedFactSet = {
  artifactId: "art-1" as never,
  marketplace: "link_url",
  extractorVersion: "test-1",
  facts: [
    {
      rawKey: "title",
      canonicalPath: null,
      extractedValue: "Test Product",
      normalizedValue: null,
      unit: null,
      sourcePointer: "$.title",
      extractionMethod: "direct",
      mappingMethod: null,
      mappingCandidates: null,
      sourceAlternatives: null,
      confidence: 0.95,
      approved: false
    }
  ],
  extractedAt: new Date()
};

describe("runExtract", () => {
  it("invokes adapter.extract and returns fact set", async () => {
    const adapter = new MockAdapter(envelope, factSet);
    const result = await runExtract({
      adapter,
      envelope,
      artifactId: "art-1" as never
    });

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.rawKey).toBe("title");
    expect(result.extractorVersion).toBe("test-1");
  });
});
