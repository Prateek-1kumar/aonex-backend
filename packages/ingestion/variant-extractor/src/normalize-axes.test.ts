import { describe, it, expect } from "bun:test";
import { normalizeAxisName, normalizeAxisValue } from "./normalize-axes.js";

describe("normalizeAxisName", () => {
  it("Color / Colour / color_family / colorway → 'color'", () => {
    expect(normalizeAxisName("Color")).toBe("color");
    expect(normalizeAxisName("Colour")).toBe("color");
    expect(normalizeAxisName("color_family")).toBe("color");
    expect(normalizeAxisName("Colorway")).toBe("color");
  });

  it("Size / size_uk / Size (UK) → 'size'", () => {
    expect(normalizeAxisName("Size")).toBe("size");
    expect(normalizeAxisName("size_uk")).toBe("size");
    expect(normalizeAxisName("Size (UK)")).toBe("size");
  });

  it("returns lowercase of unknown axis", () => {
    expect(normalizeAxisName("RAM")).toBe("ram");
  });
});

describe("normalizeAxisValue", () => {
  it("trims and title-cases color values", () => {
    expect(normalizeAxisValue("color", "  RED  ")).toBe("Red");
    expect(normalizeAxisValue("color", "navy blue")).toBe("Navy Blue");
  });
  it("uppercases size letters", () => {
    expect(normalizeAxisValue("size", "m")).toBe("M");
    expect(normalizeAxisValue("size", "xxl")).toBe("XXL");
  });
  it("preserves numeric size strings", () => {
    expect(normalizeAxisValue("size", "10.5")).toBe("10.5");
    expect(normalizeAxisValue("size", "5.5")).toBe("5.5");
  });
});
