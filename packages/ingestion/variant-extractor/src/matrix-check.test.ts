import { describe, it, expect } from "bun:test";
import { checkVariantMatrix } from "./matrix-check.js";

describe("checkVariantMatrix", () => {
  it("complete: 6 sizes × 1 color = 6 variants", () => {
    const r = checkVariantMatrix({
      variants: Array(6).fill({ optionValues: { color: "Red" } }) as never,
      axes: { color: ["Red"], size: ["S", "M", "L", "XL", "2XL", "3XL"] },
    });
    expect(r.complete).toBe(true);
    expect(r.expected).toBe(6);
    expect(r.actual).toBe(6);
  });

  it("incomplete: 7 captured, expected 12 (4×3)", () => {
    const r = checkVariantMatrix({
      variants: Array(7).fill({ optionValues: {} }) as never,
      axes: { color: ["Red", "Blue", "Green"], size: ["S", "M", "L", "XL"] },
    });
    expect(r.complete).toBe(false);
    expect(r.expected).toBe(12);
    expect(r.actual).toBe(7);
    expect(r.missing.length).toBe(5);
  });

  it("returns no expectations when no axes", () => {
    const r = checkVariantMatrix({ variants: [], axes: {} });
    expect(r.complete).toBe(true);
  });
});
