import { describe, it, expect } from "bun:test";
import { computeNullRate, detectNullRateDrift } from "./null-rate.js";

describe("computeNullRate", () => {
  it("returns zero null-rate for fully-populated cohort", () => {
    const records = [
      { title: "A", price: 10 },
      { title: "B", price: 20 }
    ];
    const result = computeNullRate(records, ["title", "price"]);
    expect(result.find((r) => r.field === "title")?.rate).toBe(0);
    expect(result.find((r) => r.field === "price")?.rate).toBe(0);
  });

  it("treats null, undefined, and empty string as missing", () => {
    const records = [
      { title: "A", brand: null },
      { title: "", brand: undefined },
      { title: "C", brand: "" }
    ];
    const titleRate = computeNullRate(records, ["title"])[0]!.rate;
    expect(titleRate).toBeCloseTo(1 / 3);
    const brandRate = computeNullRate(records, ["brand"])[0]!.rate;
    expect(brandRate).toBe(1);
  });

  it("returns 0 for empty cohort", () => {
    const result = computeNullRate([], ["title"]);
    expect(result[0]).toEqual({ field: "title", nullCount: 0, total: 0, rate: 0 });
  });

  it("returns one result per requested field", () => {
    const result = computeNullRate([{ a: 1 }], ["a", "b", "c"]);
    expect(result.map((r) => r.field)).toEqual(["a", "b", "c"]);
  });
});

describe("detectNullRateDrift", () => {
  it("flags drift when current rate exceeds baseline by threshold", () => {
    const baseline = [{ field: "price", nullCount: 5, total: 100, rate: 0.05 }];
    const current = [{ field: "price", nullCount: 30, total: 100, rate: 0.30 }];
    const reports = detectNullRateDrift(baseline, current, 0.10);
    expect(reports[0]!.drifted).toBe(true);
    expect(reports[0]!.delta).toBeCloseTo(0.25);
  });

  it("does NOT flag drift when delta is below threshold", () => {
    const baseline = [{ field: "price", nullCount: 5, total: 100, rate: 0.05 }];
    const current = [{ field: "price", nullCount: 10, total: 100, rate: 0.10 }];
    const reports = detectNullRateDrift(baseline, current, 0.10);
    expect(reports[0]!.drifted).toBe(false);
  });

  it("treats missing baseline field as 0 (new field appearing as null)", () => {
    const baseline: ReturnType<typeof computeNullRate> = [];
    const current = [{ field: "color", nullCount: 50, total: 100, rate: 0.50 }];
    const reports = detectNullRateDrift(baseline, current, 0.10);
    expect(reports[0]!.baselineRate).toBe(0);
    expect(reports[0]!.drifted).toBe(true);
  });

  it("flags negative-direction drift (suddenly populated field)", () => {
    const baseline = [{ field: "gtin", nullCount: 90, total: 100, rate: 0.90 }];
    const current = [{ field: "gtin", nullCount: 10, total: 100, rate: 0.10 }];
    const reports = detectNullRateDrift(baseline, current, 0.10);
    expect(reports[0]!.drifted).toBe(true);
    expect(reports[0]!.delta).toBeCloseTo(-0.80);
  });
});
