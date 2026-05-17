import { describe, it, expect } from "bun:test";
import { computeMatchScore, WEIGHTS, THRESHOLDS } from "./scoring.js";

describe("computeMatchScore", () => {
  it("scores 1.0 when all 4 signals match perfectly", () => {
    const score = computeMatchScore(
      { gtin: "1234567890123", modelNumber: "ABC-1", title: "Test Drill", brand: "TestBrand" },
      { gtin: "1234567890123", modelNumber: "ABC-1", title: "Test Drill", brand: "TestBrand" }
    );
    expect(score.composite).toBeCloseTo(1.0);
    expect(score.gtin).toBe(1);
    expect(score.mpn).toBe(1);
    expect(score.titleSimilarity).toBeCloseTo(1.0);
    expect(score.brand).toBe(1);
    expect(score.signalCoverage).toBeCloseTo(1.0);
  });

  it("scores ~0 when GTINs differ and nothing else matches", () => {
    const score = computeMatchScore(
      { gtin: "1111", title: "Hammer", brand: "Brand A" },
      { gtin: "2222", title: "Screwdriver", brand: "Brand B" }
    );
    expect(score.composite).toBeLessThan(0.30);
  });

  it("treats missing GTIN as null (excluded from composite) — title+brand alone can score >= 0.70", () => {
    const score = computeMatchScore(
      { title: "Aonami Pro Drill 18V Cordless", brand: "Aonami" },
      { title: "Aonami Pro Drill 18V Cordless", brand: "Aonami" }
    );
    expect(score.gtin).toBeNull();
    expect(score.mpn).toBeNull();
    expect(score.composite).toBeCloseTo(1.0);
    expect(score.signalCoverage).toBeCloseTo(WEIGHTS.TITLE_SIMILARITY + WEIGHTS.BRAND_EXACT);
  });

  it("rejects: same GTIN but different brand+title (rare; usually data error)", () => {
    const score = computeMatchScore(
      { gtin: "1234567890123", title: "Hammer", brand: "BrandA" },
      { gtin: "1234567890123", title: "Drill", brand: "BrandB" }
    );
    // GTIN: 1 * 0.40 + MPN: null + Title: low * 0.25 + Brand: 0 * 0.15
    // = 0.40 + 0 + (~0.30 * 0.25) ≈ 0.475
    expect(score.composite).toBeGreaterThan(0.40);
    expect(score.composite).toBeLessThan(0.65);
  });

  it("triggers auto-merge threshold when GTIN matches AND title is similar", () => {
    const score = computeMatchScore(
      { gtin: "1234567890123", title: "Sony WH-1000XM5 Wireless Headphones", brand: "Sony" },
      { gtin: "1234567890123", title: "Sony WH-1000XM5 Wireless Headphones (Black)", brand: "Sony" }
    );
    expect(score.composite).toBeGreaterThanOrEqual(THRESHOLDS.AUTO_MERGE);
  });

  it("returns 0 composite when no signals present on either side", () => {
    const score = computeMatchScore({}, {});
    expect(score.composite).toBe(0);
    expect(score.signalCoverage).toBe(0);
  });

  it("is symmetric (computeMatchScore(A, B) === computeMatchScore(B, A))", () => {
    const a = { gtin: "12345", title: "Pro Drill 18V", brand: "Aonami" };
    const b = { gtin: "12345", title: "Pro Drill 18V Cordless", brand: "Aonami" };
    const ab = computeMatchScore(a, b);
    const ba = computeMatchScore(b, a);
    expect(ab.composite).toBeCloseTo(ba.composite);
  });

  it("is case- and whitespace-insensitive on exact-match signals", () => {
    const score = computeMatchScore(
      { gtin: " 1234567 ", brand: "AONAMI" },
      { gtin: "1234567", brand: "Aonami" }
    );
    expect(score.gtin).toBe(1);
    expect(score.brand).toBe(1);
  });
});
