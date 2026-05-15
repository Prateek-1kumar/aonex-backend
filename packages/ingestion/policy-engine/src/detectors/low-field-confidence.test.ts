import { describe, it, expect } from "bun:test";
import { detectLowFieldConfidence } from "./low-field-confidence.js";
import type { RouterInput } from "../types.js";

function input(overrides: Partial<RouterInput> = {}): RouterInput {
  return {
    facts: [],
    payload: {
      title: "T", brand: null, gtin: null, modelNumber: null,
      basePrice: 9.99, currency: "USD", canonicalCategory: "x/y", variants: [],
    },
    domain: "example.com",
    category: { path: "x/y", confidence: 0.9 },
    categoryRequiredAttributes: [],
    identityIndex: {},
    priceCluster: null,
    variantAxes: {},
    ...overrides,
  } as RouterInput;
}

describe("detectLowFieldConfidence", () => {
  it("fires when a required field's confidence < 0.70", () => {
    const signal = detectLowFieldConfidence(input({
      facts: [
        { rawKey: "title", confidence: 0.55, extractedValue: "T" } as never,
        { rawKey: "base_price", confidence: 0.90, extractedValue: 9.99 } as never,
      ],
    }));
    expect(signal).not.toBeNull();
    expect(signal!.signalKind).toBe("low_confidence_mapping");
    expect(signal!.severity).toBe("medium");
    expect(signal!.payload.affectedFields).toContain("title");
  });

  it("does not fire when all required fields ≥ 0.70", () => {
    expect(
      detectLowFieldConfidence(input({
        facts: [
          { rawKey: "title", confidence: 0.85, extractedValue: "T" } as never,
          { rawKey: "base_price", confidence: 0.90, extractedValue: 9.99 } as never,
        ],
      }))
    ).toBeNull();
  });
});
