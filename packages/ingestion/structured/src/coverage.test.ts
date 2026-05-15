import { describe, it, expect } from "bun:test";
import { checkCoverage } from "./coverage.js";

describe("checkCoverage", () => {
  it("full coverage when title+price+currency+variants+category present", () => {
    const r = checkCoverage(
      [
        { rawKey: "title", extractedValue: "T" },
        { rawKey: "base_price", extractedValue: 99 },
        { rawKey: "currency", extractedValue: "USD" },
        { rawKey: "variants[0].option.size", extractedValue: "M" },
        { rawKey: "productType", extractedValue: "apparel/t_shirts" },
      ] as unknown as Parameters<typeof checkCoverage>[0],
      []
    );
    expect(r.complete).toBe(true);
    expect(r.gaps).toEqual([]);
  });

  it("flags missing core fields", () => {
    const r = checkCoverage(
      [{ rawKey: "title", extractedValue: "T" }] as unknown as Parameters<typeof checkCoverage>[0],
      []
    );
    expect(r.complete).toBe(false);
    expect(r.gaps).toEqual(
      expect.arrayContaining(["base_price", "currency", "variants", "productType"])
    );
  });

  it("flags missing category-required attributes", () => {
    const r = checkCoverage(
      [
        { rawKey: "title", extractedValue: "T" },
        { rawKey: "base_price", extractedValue: 99 },
        { rawKey: "currency", extractedValue: "USD" },
        { rawKey: "variants[0].option.size", extractedValue: "M" },
        { rawKey: "productType", extractedValue: "apparel/t_shirts" },
      ] as unknown as Parameters<typeof checkCoverage>[0],
      ["material", "fit"]
    );
    expect(r.complete).toBe(false);
    expect(r.gaps).toEqual(["material", "fit"]);
  });
});
