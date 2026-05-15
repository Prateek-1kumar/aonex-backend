import { describe, it, expect } from "bun:test";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import { inferCurrency } from "./currency-inference.js";

describe("inferCurrency", () => {
  it("infers INR for .in TLD", () => {
    const f = inferCurrency("https://www.bewakoof.com/p/foo", []);
    // Bewakoof is .com → should not infer; test the .in case below.
    expect(f).toBeNull();
  });

  it("infers INR for an explicit .in host", () => {
    const f = inferCurrency("https://www.decathlon.in/p/1/x", []);
    expect(f).not.toBeNull();
    expect(f!.extractedValue).toBe("INR");
    expect(f!.confidence).toBeCloseTo(0.70, 2);
    expect(f!.extractionMethod).toBe("inferred");
    expect(f!.sourcePointer).toContain("tld_inference");
  });

  it("infers AUD for .au TLD", () => {
    const f = inferCurrency("https://www.asos.com.au/p/x", []);
    expect(f?.extractedValue).toBe("AUD");
  });

  it("returns null when currency already present", () => {
    const existing: ExtractedFact = {
      rawKey: "currency",
      canonicalPath: null,
      extractedValue: "USD",
      normalizedValue: "USD",
      unit: null,
      sourcePointer: "jsonld:Product.currency",
      extractionMethod: "direct",
      confidence: 0.95,
      mappingMethod: null,
      mappingCandidates: null,
      sourceAlternatives: null,
      approved: false,
    };
    expect(inferCurrency("https://www.example.in/p", [existing])).toBeNull();
  });

  it("returns null for ambiguous .com host", () => {
    expect(inferCurrency("https://www.example.com/p", [])).toBeNull();
  });

  it("returns null for malformed URL", () => {
    expect(inferCurrency("not a url", [])).toBeNull();
  });

  it("returns null for an unknown TLD", () => {
    expect(inferCurrency("https://example.xyz/p", [])).toBeNull();
  });
});
