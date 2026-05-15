import { describe, it, expect } from "bun:test";
import { detectCrossSourceConflict } from "./cross-source-conflict.js";

describe("detectCrossSourceConflict", () => {
  it("fires when two facts on the same rawKey disagree from different sources", () => {
    const facts = [
      { rawKey: "title", extractedValue: "Ekiden One", sourcePointer: "jsonld:Product.name", confidence: 0.95, mappingCandidates: [{ key: "opengraph:og:title", score: 0.65, reason: "alt source" }] } as never,
    ];
    const s = detectCrossSourceConflict({ facts, payload: { title: "Ekiden One" } as never, domain: "x.com" } as never);
    expect(s).not.toBeNull();
    expect(s!.signalKind).toBe("field_conflict");
    expect(s!.severity).toBe("high");
    expect(s!.payload.candidates?.length).toBeGreaterThanOrEqual(2);
  });

  it("does not fire when no mappingCandidates exist (single source)", () => {
    const facts = [
      { rawKey: "title", extractedValue: "T", sourcePointer: "jsonld:Product.name", confidence: 0.95, mappingCandidates: null } as never,
    ];
    expect(detectCrossSourceConflict({ facts, payload: {} as never, domain: "x.com" } as never)).toBeNull();
  });
});

describe("detectCrossSourceConflict unit-aware", () => {
  it("does not fire when the rawKey is unit-aware AND fact carries a convertible unit", () => {
    const facts = [
      {
        rawKey: "chest_inches",
        extractedValue: 42,
        unit: "in",
        sourcePointer: "jsonld:Product.chest_inches",
        confidence: 0.95,
        mappingCandidates: [{ key: "next_data:chest_cm", score: 0.85, reason: "alt source" }],
      } as never,
    ];
    expect(detectCrossSourceConflict({ facts, payload: {} as never, domain: "x.com" } as never)).toBeNull();
  });

  it("still fires for non-unit-aware fields (e.g., title) even with mappingCandidates", () => {
    const facts = [
      {
        rawKey: "title",
        extractedValue: "Ekiden One",
        unit: null,
        sourcePointer: "jsonld",
        confidence: 0.95,
        mappingCandidates: [{ key: "opengraph", score: 0.65, reason: "alt source" }],
      } as never,
    ];
    expect(detectCrossSourceConflict({ facts, payload: {} as never, domain: "x.com" } as never)).not.toBeNull();
  });
});
