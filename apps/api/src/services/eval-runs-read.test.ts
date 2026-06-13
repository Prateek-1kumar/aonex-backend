import { describe, expect, test } from "bun:test";
import { computeRegression, type EvalSkuMetric } from "./eval-runs-read.js";

const sku = (over: Partial<EvalSkuMetric> & { goldenId: string }): EvalSkuMetric => ({
  categorizationCorrect: true,
  completenessAfter: 80,
  groundingRate: 1,
  goldAttrHits: 2,
  goldAttrTotal: 2,
  fields: [],
  ...over,
});

describe("computeRegression", () => {
  test("no change -> zero regressions", () => {
    const prev = [sku({ goldenId: "e01" }), sku({ goldenId: "f01" })];
    const curr = [sku({ goldenId: "e01" }), sku({ goldenId: "f01" })];
    expect(computeRegression(prev, curr).count).toBe(0);
  });

  test("categorization flip correct->incorrect is a regression", () => {
    const prev = [sku({ goldenId: "e01", categorizationCorrect: true })];
    const curr = [sku({ goldenId: "e01", categorizationCorrect: false })];
    const r = computeRegression(prev, curr);
    expect(r.count).toBe(1);
    expect(r.details[0]!.reasons.join()).toContain("categorization");
  });

  test("completeness drop beyond epsilon is a regression; tiny noise is not", () => {
    expect(computeRegression([sku({ goldenId: "a", completenessAfter: 80 })], [sku({ goldenId: "a", completenessAfter: 70 })]).count).toBe(1);
    expect(computeRegression([sku({ goldenId: "a", completenessAfter: 80 })], [sku({ goldenId: "a", completenessAfter: 79.9 })]).count).toBe(0);
  });

  test("a field grounding slip down the hierarchy is a regression", () => {
    const prev = [sku({ goldenId: "a", fields: [{ key: "color", grounding: "grounded", accepted: true }] })];
    const curr = [sku({ goldenId: "a", fields: [{ key: "color", grounding: "inferred", accepted: false }] })];
    expect(computeRegression(prev, curr).count).toBe(1);
  });

  test("grounding IMPROVEMENT is not a regression", () => {
    const prev = [sku({ goldenId: "a", fields: [{ key: "color", grounding: "inferred", accepted: false }] })];
    const curr = [sku({ goldenId: "a", fields: [{ key: "color", grounding: "grounded", accepted: true }] })];
    expect(computeRegression(prev, curr).count).toBe(0);
  });

  test("gold-attr accuracy drop is a regression", () => {
    const prev = [sku({ goldenId: "a", goldAttrHits: 2, goldAttrTotal: 2 })];
    const curr = [sku({ goldenId: "a", goldAttrHits: 1, goldAttrTotal: 2 })];
    expect(computeRegression(prev, curr).count).toBe(1);
  });

  test("a newly added SKU (absent in prev) is never a regression", () => {
    const prev = [sku({ goldenId: "a" })];
    const curr = [sku({ goldenId: "a" }), sku({ goldenId: "b", categorizationCorrect: false })];
    expect(computeRegression(prev, curr).count).toBe(0);
  });
});
