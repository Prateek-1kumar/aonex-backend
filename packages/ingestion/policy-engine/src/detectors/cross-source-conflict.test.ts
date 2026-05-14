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
