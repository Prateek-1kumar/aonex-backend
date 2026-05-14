import { describe, it, expect } from "bun:test";
import { detectPriceAnomaly } from "./price-anomaly.js";

describe("detectPriceAnomaly", () => {
  it("fires when price > 5× cluster median (sample ≥ 10)", () => {
    const s = detectPriceAnomaly({
      payload: { basePrice: 6000, brand: "X", canonicalCategory: "x/y" } as never,
      priceCluster: { medianPrice: 1000, sampleCount: 12 },
      facts: [], domain: "x.com",
    } as never);
    expect(s).not.toBeNull();
    expect(s!.severity).toBe("high");
  });

  it("fires when price < 0.2× cluster median", () => {
    const s = detectPriceAnomaly({
      payload: { basePrice: 100, brand: "X", canonicalCategory: "x/y" } as never,
      priceCluster: { medianPrice: 1000, sampleCount: 12 },
      facts: [], domain: "x.com",
    } as never);
    expect(s).not.toBeNull();
  });

  it("does not fire when sample < 10", () => {
    expect(
      detectPriceAnomaly({
        payload: { basePrice: 99999, brand: "X", canonicalCategory: "x/y" } as never,
        priceCluster: { medianPrice: 1000, sampleCount: 5 },
        facts: [], domain: "x.com",
      } as never)
    ).toBeNull();
  });

  it("does not fire when no cluster supplied", () => {
    expect(
      detectPriceAnomaly({
        payload: { basePrice: 99999, brand: "X", canonicalCategory: "x/y" } as never,
        priceCluster: null,
        facts: [], domain: "x.com",
      } as never)
    ).toBeNull();
  });
});
