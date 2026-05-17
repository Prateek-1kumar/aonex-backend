import { describe, it, expect } from "bun:test";
import { compareCanonicalRows, type ComparisonResult } from "./shadow-compare.js";

describe("compareCanonicalRows", () => {
  it("returns zero diffs when rows match field-by-field", () => {
    const r1 = { title: "A", brand: "B", basePrice: 10, attributes_json: { color: "Red" } };
    const r2 = { title: "A", brand: "B", basePrice: 10, attributes_json: { color: "Red" } };
    const result = compareCanonicalRows(r1, r2);
    expect(result.differingFields).toEqual([]);
    expect(result.diffRatio).toBe(0);
  });

  it("flags differing primitive field", () => {
    const r1 = { title: "A", brand: "B" };
    const r2 = { title: "A", brand: "C" };
    const result = compareCanonicalRows(r1, r2);
    expect(result.differingFields).toContain("brand");
    expect(result.diffRatio).toBeGreaterThan(0);
  });

  it("flags differing jsonb fields by key", () => {
    const r1 = { attributes_json: { color: "Red", size: 5 } };
    const r2 = { attributes_json: { color: "Red", size: 7 } };
    const result = compareCanonicalRows(r1, r2);
    expect(result.differingFields).toContain("attributes_json.size");
  });
});
