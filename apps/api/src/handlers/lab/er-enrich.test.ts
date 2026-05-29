import { test, expect } from "bun:test";
import { scoreCandidatePair } from "./er-enrich.js";

test("computes PairScore for a same-product candidate", () => {
  const score = scoreCandidatePair(
    { title: "Google Pixel 10 5G", brand: "Google", variant: { storage: "256GB" }, price: 79999 },
    { productId: "p1", title: "Google Pixel 10 5G", brand: "Google", variant: { storage: "256GB" }, price: 80000 }
  );
  expect(score).not.toBeNull();
  expect(score!.composite).toBeGreaterThan(0.8);
  expect(score!.titleSim).toBeCloseTo(1, 5);
  expect(score!.specAgreement).toBe(1);
  expect(score!.priceProximity).toBe(1);
});

test("returns null when candidate has no title", () => {
  const score = scoreCandidatePair(
    { title: "X", brand: "Y", variant: {}, price: null },
    { productId: "p2", title: null, brand: null, variant: {}, price: null }
  );
  expect(score).toBeNull();
});

test("penalizes pair with conflicting specs", () => {
  const score = scoreCandidatePair(
    { title: "Pixel 10 5G", brand: "Google", variant: { storage: "128GB" }, price: 70000 },
    { productId: "p3", title: "Pixel 10 5G", brand: "Google", variant: { storage: "256GB" }, price: 80000 }
  );
  expect(score).not.toBeNull();
  expect(score!.composite).toBeLessThan(0.5); // spec conflict cap (Phase 4 Task 2)
});
