import { describe, it, expect } from "bun:test";
import { detectVariantIncomplete } from "./variant-incomplete.js";

describe("detectVariantIncomplete", () => {
  it("fires when actual variant count < cross-product of axes", () => {
    const s = detectVariantIncomplete({
      payload: { variants: Array(7).fill({ optionValues: {}, sku: null, price: null }) } as never,
      variantAxes: { size: ["S","M","L","XL"], color: ["Red","Blue","Green"] }, // 4*3=12
      facts: [], domain: "x.com",
    } as never);
    expect(s).not.toBeNull();
    expect(s!.payload.evidence).toMatchObject({ expected: 12, actual: 7 });
  });

  it("does not fire when actual == expected", () => {
    expect(
      detectVariantIncomplete({
        payload: { variants: Array(6).fill({ optionValues: {}, sku: null, price: null }) } as never,
        variantAxes: { size: ["S","M","L"], color: ["Red","Blue"] },
        facts: [], domain: "x.com",
      } as never)
    ).toBeNull();
  });

  it("does not fire when no axes detected", () => {
    expect(
      detectVariantIncomplete({
        payload: { variants: [] } as never,
        variantAxes: {},
        facts: [], domain: "x.com",
      } as never)
    ).toBeNull();
  });
});
