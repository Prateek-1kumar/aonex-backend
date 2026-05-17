import { describe, it, expect } from "bun:test";
import { detectSchemaDrift } from "./schema.js";

describe("detectSchemaDrift", () => {
  it("flags a new key that appeared in current but was absent in baseline", () => {
    const baseline = Array.from({ length: 100 }, () => ({ title: "x", brand: "y" }));
    const current = Array.from({ length: 100 }, () => ({ title: "x", brand: "y", new_field: "z" }));
    const result = detectSchemaDrift(baseline, current);
    expect(result.newKeys).toHaveLength(1);
    expect(result.newKeys[0]!.key).toBe("new_field");
    expect(result.newKeys[0]!.currentFrequency).toBe(1.0);
  });

  it("does NOT flag a rare new key (below threshold)", () => {
    const baseline = Array.from({ length: 100 }, () => ({ title: "x" }));
    // Only 5% of current has the new key — below 20% threshold
    const current = Array.from({ length: 100 }, (_, i) => i < 5 ? { title: "x", trivia: "z" } : { title: "x" });
    const result = detectSchemaDrift(baseline, current);
    expect(result.newKeys).toHaveLength(0);
  });

  it("flags a vanished key (present in baseline, absent in current)", () => {
    const baseline = Array.from({ length: 100 }, () => ({ title: "x", color: "red" }));
    const current = Array.from({ length: 100 }, () => ({ title: "x" }));
    const result = detectSchemaDrift(baseline, current);
    expect(result.vanishedKeys.find((v) => v.key === "color")).toBeDefined();
  });

  it("does not flag stable keys", () => {
    const baseline = Array.from({ length: 50 }, () => ({ title: "x", brand: "y" }));
    const current = Array.from({ length: 50 }, () => ({ title: "x", brand: "y" }));
    const result = detectSchemaDrift(baseline, current);
    expect(result.newKeys).toEqual([]);
    expect(result.vanishedKeys).toEqual([]);
  });

  it("respects custom thresholds", () => {
    const baseline = Array.from({ length: 100 }, () => ({ title: "x" }));
    // 10% has new key — above 5% threshold but below default 20%
    const current = Array.from({ length: 100 }, (_, i) => i < 10 ? { title: "x", new_key: "y" } : { title: "x" });
    const defaultResult = detectSchemaDrift(baseline, current);
    expect(defaultResult.newKeys).toHaveLength(0);
    const loosenedResult = detectSchemaDrift(baseline, current, { newKeyThreshold: 0.05 });
    expect(loosenedResult.newKeys).toHaveLength(1);
  });

  it("returns empty for empty cohorts", () => {
    const result = detectSchemaDrift([], []);
    expect(result.newKeys).toEqual([]);
    expect(result.vanishedKeys).toEqual([]);
  });
});
