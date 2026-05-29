import { test, expect } from "bun:test";
import { wouldErAutoMerge, erMetrics, stubEmbedding, defaultPairToSides, ER_PRECISION_BAR, ER_RECALL_BAR } from "./er-eval.js";
import type { IdentityPair } from "./merge-pairs.js";

test("stubEmbedding is deterministic and L2-normalized", () => {
  const a = stubEmbedding("Google Pixel 10 5G");
  const b = stubEmbedding("Google Pixel 10 5G");
  expect(a).toEqual(b);
  const len = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  expect(len).toBeCloseTo(1, 5); // unit vector
});

test("wouldErAutoMerge: same product → true", () => {
  expect(wouldErAutoMerge(
    { title: "Google Pixel 10 5G", specs: { storage: "256GB" }, price: 79999 },
    { title: "Google Pixel 10 5G", specs: { storage: "256GB" }, price: 80000 }
  )).toBe(true);
});

test("wouldErAutoMerge: different specs → false (variant guard echo)", () => {
  expect(wouldErAutoMerge(
    { title: "Google Pixel 10 5G", specs: { storage: "128GB" }, price: 79999 },
    { title: "Google Pixel 10 5G", specs: { storage: "256GB" }, price: 80000 }
  )).toBe(false);
});

test("ER constants are reasonable defaults", () => {
  expect(ER_PRECISION_BAR).toBeGreaterThanOrEqual(0.8);
  expect(ER_RECALL_BAR).toBeGreaterThanOrEqual(0.5);
});

test("erMetrics on a simple labeled set computes precision/recall", () => {
  const pairs: IdentityPair[] = [
    {
      id: "p1", label: "same",
      a: { identifiers: [{ type: "gtin", value: "Google Pixel 10 5G", source: "x" }], variant: { storage: "256GB" } },
      b: { identifiers: [{ type: "gtin", value: "Google Pixel 10 5G", source: "y" }], variant: { storage: "256GB" } },
    },
    {
      id: "p2", label: "different",
      a: { identifiers: [{ type: "gtin", value: "Samsung Galaxy S25", source: "x" }], variant: { storage: "256GB" } },
      b: { identifiers: [{ type: "gtin", value: "Apple iPhone 17",   source: "y" }], variant: { storage: "256GB" } },
    },
  ];
  const m = erMetrics(pairs, defaultPairToSides);
  expect(m.total).toBe(2);
  // Same-product pair should be a TP; different-products pair should NOT be a FP.
  expect(m.truePositive).toBe(1);
  expect(m.falsePositive).toBe(0);
  expect(m.precision).toBe(1);
  expect(m.recall).toBe(1);
});
