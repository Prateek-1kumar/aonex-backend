import { describe, it, expect } from "bun:test";
import { parseUnit } from "./unit-parser.js";

describe("parseUnit", () => {
  it("splits 1.5kg", () => expect(parseUnit("1.5kg")).toEqual({ value: 1.5, unit: "kg" }));
  it("splits 1.5 kg", () => expect(parseUnit("1.5 kg")).toEqual({ value: 1.5, unit: "kg" }));
  it("handles grams long form", () => expect(parseUnit("1500 grams")).toEqual({ value: 1500, unit: "g" }));
  it("handles fl oz", () => expect(parseUnit("12 fl oz")).toEqual({ value: 12, unit: "floz" }));
  it("handles GB (uppercase)", () => expect(parseUnit("256 GB")).toEqual({ value: 256, unit: "GB" }));
  it("handles mAh", () => expect(parseUnit("4500 mAh")).toEqual({ value: 4500, unit: "mAh" }));
  it("handles inches plural", () => expect(parseUnit("13 inches")).toEqual({ value: 13, unit: "in" }));
  it("handles ml", () => expect(parseUnit("250 ml")).toEqual({ value: 250, unit: "ml" }));
  it("handles negative numbers", () => expect(parseUnit("-5 cm")).toEqual({ value: -5, unit: "cm" }));
  it("returns null for unrecognized", () => expect(parseUnit("foo bar")).toBeNull());
  it("returns null for empty", () => expect(parseUnit("")).toBeNull());
  it("returns null when no unit", () => expect(parseUnit("42")).toBeNull());
});
