import { describe, it, expect } from "bun:test";
import { detectMissingRequiredAttribute } from "./missing-required-attribute.js";

const baseInput = {
  facts: [{ rawKey: "title", extractedValue: "T", confidence: 0.9 }] as never[],
  payload: { title: "T", brand: null, gtin: null, modelNumber: null, basePrice: 9.99, currency: "USD", canonicalCategory: "apparel/t_shirts", variants: [] },
  domain: "x.com",
  category: { path: "apparel/t_shirts", confidence: 0.9 },
  identityIndex: {},
  priceCluster: null,
  variantAxes: {},
};

describe("detectMissingRequiredAttribute", () => {
  it("fires when required attr missing from facts", () => {
    const s = detectMissingRequiredAttribute({ ...baseInput, categoryRequiredAttributes: ["material", "fit"] } as never);
    expect(s).not.toBeNull();
    expect(s!.payload.affectedFields).toEqual(expect.arrayContaining(["material", "fit"]));
  });

  it("returns null when all required attrs present", () => {
    const s = detectMissingRequiredAttribute({
      ...baseInput,
      facts: [
        ...baseInput.facts,
        { rawKey: "material", extractedValue: "Cotton", confidence: 0.8 } as never,
        { rawKey: "fit", extractedValue: "Regular", confidence: 0.8 } as never,
      ],
      categoryRequiredAttributes: ["material", "fit"],
    } as never);
    expect(s).toBeNull();
  });

  it("severity=high when missing affects core fields (title/price)", () => {
    const s = detectMissingRequiredAttribute({ ...baseInput, payload: { ...baseInput.payload, title: null }, categoryRequiredAttributes: [] } as never);
    expect(s?.severity).toBe("high");
  });
});
