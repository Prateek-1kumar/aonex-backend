import { describe, it, expect } from "bun:test";
import { calibrateFacts, noopCalibrationLookup, type CalibrationLookup } from "./calibration.js";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import { fitIsotonic } from "@aonex/calibration";

function fact(rawKey: string, confidence: number): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue: "x",
    normalizedValue: null,
    unit: null,
    sourcePointer: "test",
    extractionMethod: "direct",
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    confidence,
    approved: false
  };
}

describe("calibrateFacts", () => {
  const context = { extractor: "json-ld@1.0", category: "x/y", sourceType: "link_url" };

  it("returns identity-copied facts when lookup returns null", () => {
    const input = [fact("title", 0.95), fact("brand", 0.80)];
    const output = calibrateFacts(input, context, noopCalibrationLookup);
    expect(output).toHaveLength(2);
    expect(output[0]!.confidence).toBe(0.95);
    expect(output[1]!.confidence).toBe(0.80);
  });

  it("returns shallow copies (not the same references)", () => {
    const input = [fact("title", 0.95)];
    const output = calibrateFacts(input, context, noopCalibrationLookup);
    expect(output[0]).not.toBe(input[0]);    // different object identity
    expect(output[0]!.rawKey).toBe("title");
  });

  it("applies the calibration model when lookup returns one", () => {
    // Fit a model that maps 0.9 → 0.6 (overconfident raw → calibrated downward)
    const model = fitIsotonic([
      ...Array.from({ length: 30 }, (_, i) => ({ rawConfidence: 0.9, outcome: (i < 18 ? 1 : 0) as 0 | 1 }))
    ]);
    const lookup: CalibrationLookup = () => model;
    const input = [fact("title", 0.9)];
    const output = calibrateFacts(input, context, lookup);
    expect(output[0]!.confidence).toBeCloseTo(0.6, 1);
  });

  it("forwards the calibration key (extractor × category × sourceType) to lookup", () => {
    let receivedKey: { extractor: string; category: string | null; sourceType: string } | null = null;
    const lookup: CalibrationLookup = (k) => {
      receivedKey = k;
      return null;
    };
    calibrateFacts([fact("title", 0.8)], context, lookup);
    expect(receivedKey!).toEqual({ extractor: "json-ld@1.0", category: "x/y", sourceType: "link_url" });
  });

  it("handles null category (asks lookup with null category)", () => {
    let receivedKey: { category: string | null } | null = null;
    const lookup: CalibrationLookup = (k) => {
      receivedKey = k;
      return null;
    };
    calibrateFacts([fact("title", 0.8)], { extractor: "e", category: null, sourceType: "link_url" }, lookup);
    expect(receivedKey!.category).toBeNull();
  });

  it("doesn't mutate the input array", () => {
    const original = [fact("title", 0.95), fact("brand", 0.80)];
    const model = fitIsotonic([
      ...Array.from({ length: 30 }, (_, i) => ({ rawConfidence: 0.95, outcome: (i < 18 ? 1 : 0) as 0 | 1 }))
    ]);
    calibrateFacts(original, context, () => model);
    expect(original[0]!.confidence).toBe(0.95);
    expect(original[1]!.confidence).toBe(0.80);
  });
});

describe("noopCalibrationLookup", () => {
  it("always returns null", () => {
    expect(noopCalibrationLookup({ extractor: "x", category: "y", sourceType: "z" })).toBeNull();
  });
});
