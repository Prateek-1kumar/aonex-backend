import { describe, it, expect } from "bun:test";
import { detectCrossSourceConflict } from "./cross-source-conflict.js";

describe("detectCrossSourceConflict", () => {
  it("fires when two sources extracted different values for the same rawKey", () => {
    const facts = [
      {
        rawKey: "title",
        extractedValue: "Ekiden One",
        sourcePointer: "jsonld:Product.name",
        confidence: 0.95,
        sourceAlternatives: [
          { value: "Different Title From OG", sourcePointer: "opengraph:og:title", confidence: 0.65 },
        ],
      } as never,
    ];
    const s = detectCrossSourceConflict({ facts, payload: { title: "Ekiden One" } as never, domain: "x.com" } as never);
    expect(s).not.toBeNull();
    expect(s!.signalKind).toBe("field_conflict");
    expect(s!.severity).toBe("high");
    expect(s!.payload.candidates?.length).toBe(2);
    expect(s!.payload.candidates?.[1]?.value).toBe("Different Title From OG");
    expect(s!.payload.candidates?.[1]?.source).toBe("opengraph:og:title");
  });

  it("does not fire when no sourceAlternatives exist (single source)", () => {
    const facts = [
      {
        rawKey: "title",
        extractedValue: "T",
        sourcePointer: "jsonld:Product.name",
        confidence: 0.95,
        sourceAlternatives: null,
      } as never,
    ];
    expect(detectCrossSourceConflict({ facts, payload: {} as never, domain: "x.com" } as never)).toBeNull();
  });

  it("does not fire when alt values match the winner (no real conflict)", () => {
    const facts = [
      {
        rawKey: "title",
        extractedValue: "Ekiden One",
        sourcePointer: "jsonld:Product.name",
        confidence: 0.95,
        sourceAlternatives: [
          { value: "ekiden one", sourcePointer: "opengraph:og:title", confidence: 0.65 },
        ],
      } as never,
    ];
    // Same value (case-insensitive) — should not fire
    expect(detectCrossSourceConflict({ facts, payload: {} as never, domain: "x.com" } as never)).toBeNull();
  });
});

describe("detectCrossSourceConflict unit-aware", () => {
  it("does not fire when alts are convertible to the same canonical value", () => {
    const facts = [
      {
        rawKey: "chest_inches",
        extractedValue: 42,
        unit: "in",
        sourcePointer: "jsonld:Product.chest_inches",
        confidence: 0.95,
        sourceAlternatives: [
          // 42 inches in any source — same value, just a different source
          { value: 42, sourcePointer: "next_data:chest", confidence: 0.85 },
        ],
      } as never,
    ];
    expect(detectCrossSourceConflict({ facts, payload: {} as never, domain: "x.com" } as never)).toBeNull();
  });

  it("fires for non-unit-aware fields when alt values disagree", () => {
    const facts = [
      {
        rawKey: "title",
        extractedValue: "Ekiden One",
        unit: null,
        sourcePointer: "jsonld",
        confidence: 0.95,
        sourceAlternatives: [
          { value: "Ekiden Two", sourcePointer: "opengraph", confidence: 0.65 },
        ],
      } as never,
    ];
    expect(detectCrossSourceConflict({ facts, payload: {} as never, domain: "x.com" } as never)).not.toBeNull();
  });
});
