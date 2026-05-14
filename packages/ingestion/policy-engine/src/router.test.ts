import { describe, it, expect } from "bun:test";
import { route, clusterKey } from "./router.js";
import type { RouterInput, ReviewTaskSignal } from "./types.js";

function clean(): RouterInput {
  return {
    facts: [
      { rawKey: "title", extractedValue: "T", confidence: 0.95, sourcePointer: "x", mappingCandidates: null } as never,
      { rawKey: "base_price", extractedValue: 99, confidence: 0.95, sourcePointer: "x", mappingCandidates: null } as never,
      { rawKey: "currency", extractedValue: "USD", confidence: 0.95, sourcePointer: "x", mappingCandidates: null } as never,
    ],
    payload: { title: "T", brand: "B", gtin: null, modelNumber: null, basePrice: 99, currency: "USD", canonicalCategory: "x/y", variants: [{ optionValues: {}, sku: "S1", price: 99 }] },
    domain: "x.com",
    category: { path: "x/y", confidence: 0.95 },
    categoryRequiredAttributes: [],
    identityIndex: {},
    priceCluster: null,
    variantAxes: {},
  };
}

describe("route", () => {
  it("auto_approve when zero detectors fire", () => {
    const r = route(clean());
    expect(r.route).toBe("auto_approve");
    expect(r.reviewTasks).toEqual([]);
    expect(r.score).toBe(1.0);
  });

  it("review when any detector fires", () => {
    const input = clean();
    input.facts[0]!.confidence = 0.55; // trips low_confidence_mapping
    const r = route(input);
    expect(r.route).toBe("review");
    expect(r.reviewTasks.length).toBeGreaterThanOrEqual(1);
    expect(r.score).toBeLessThan(1.0);
  });

  it("cluster_key derived from signal_kind + clusterDimensions is deterministic", () => {
    const input = clean();
    input.facts[0]!.confidence = 0.55;
    const r1 = route(input);
    const r2 = route(input);
    expect(r1.reviewTasks[0]!.clusterDimensions).toEqual(r2.reviewTasks[0]!.clusterDimensions);
    const k1 = clusterKey(r1.reviewTasks[0]!);
    const k2 = clusterKey(r2.reviewTasks[0]!);
    expect(k1).toBe(k2);
    expect(k1.length).toBe(16);
  });
});
