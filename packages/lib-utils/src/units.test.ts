import { describe, it, expect } from "bun:test";
import { convertToCanonical, canonicalUnitFor } from "./units.js";

describe("convertToCanonical", () => {
  it("inches → cm", () => {
    const r = convertToCanonical(42, "in", "length");
    expect(r?.value).toBeCloseTo(106.68, 2);
    expect(r?.unit).toBe("cm");
  });
  it("kg → g", () => {
    expect(convertToCanonical(1.5, "kg", "mass")).toEqual({ value: 1500, unit: "g" });
  });
  it("Wh stays Wh (already canonical)", () => {
    expect(convertToCanonical(50, "Wh", "energy")).toEqual({ value: 50, unit: "Wh" });
  });
  it("returns null when unknown unit for dimension", () => {
    expect(convertToCanonical(50, "furlong", "length")).toBeNull();
  });
  it("returns null for mAh (needs voltage, marked non-convertible)", () => {
    expect(convertToCanonical(5000, "mAh", "energy")).toBeNull();
  });
});

describe("canonicalUnitFor", () => {
  it("returns cm for length", () => {
    expect(canonicalUnitFor("length")).toBe("cm");
  });
  it("returns Wh for energy", () => {
    expect(canonicalUnitFor("energy")).toBe("Wh");
  });
});
