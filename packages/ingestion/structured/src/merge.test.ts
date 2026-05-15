import { describe, it, expect } from "bun:test";
import { mergeParserOutputs } from "./merge.js";
import type { ParserOutput } from "./types.js";

function mk(kind: ParserOutput["kind"], rawKey: string, value: unknown, confidence: number): ParserOutput {
  return {
    kind,
    facts: [
      {
        rawKey,
        canonicalPath: null,
        extractedValue: value,
        normalizedValue: value,
        unit: null,
        sourcePointer: `${kind}:${rawKey}`,
        extractionMethod: "direct",
        confidence,
        mappingMethod: null,
        mappingCandidates: null,
        sourceAlternatives: null,
        approved: false,
      },
    ],
    baselineConfidence: confidence,
  };
}

describe("mergeParserOutputs", () => {
  it("keeps highest-confidence fact per rawKey", () => {
    const ld = mk("json_ld", "title", "JSON-LD title", 0.95);
    const og = mk("opengraph", "title", "OG title", 0.65);
    const merged = mergeParserOutputs([ld, og]);
    const title = merged.facts.find((f) => f.rawKey === "title");
    expect(title?.extractedValue).toBe("JSON-LD title");
    expect(title?.confidence).toBeCloseTo(0.95);
  });

  it("preserves losing values + sources in sourceAlternatives", () => {
    const ld = mk("json_ld", "title", "Ekiden One", 0.95);
    const og = mk("opengraph", "title", "Kalenji Run 100", 0.65);
    const merged = mergeParserOutputs([ld, og]);
    const title = merged.facts.find((f) => f.rawKey === "title")!;
    expect(title.sourceAlternatives).toEqual([
      { value: "Kalenji Run 100", sourcePointer: "opengraph:title", confidence: 0.65 },
    ]);
  });

  it("drops alts whose value matches the winner (no false conflict)", () => {
    const ld = mk("json_ld", "title", "Ekiden One", 0.95);
    const og = mk("opengraph", "title", "ekiden one", 0.65); // same, different case
    const merged = mergeParserOutputs([ld, og]);
    const title = merged.facts.find((f) => f.rawKey === "title")!;
    expect(title.sourceAlternatives).toBeNull();
  });
});
