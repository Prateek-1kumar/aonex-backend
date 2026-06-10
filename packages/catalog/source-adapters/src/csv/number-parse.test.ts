import { describe, expect, test } from "bun:test";
import { parseDecimal } from "./number-parse.js";

const val = (s: string) => parseDecimal(s)?.value;

describe("parseDecimal — US / existing behavior (no regression)", () => {
  test("plain + currency + thousands", () => {
    expect(val("50")).toBe(50);
    expect(val("0.8")).toBe(0.8);
    expect(val("12.99")).toBe(12.99);
    expect(val("99.95")).toBe(99.95);
    expect(val("$1,299.00")).toBe(1299);
    expect(val("1,234")).toBe(1234);
    expect(val("1,234,567.89")).toBe(1234567.89);
  });
  test("non-numeric -> null (rejected, not coerced to 0)", () => {
    expect(parseDecimal("N/A")).toBeNull();
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("   ")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
  });
});

describe("parseDecimal — European / accounting (the corruption fixes)", () => {
  test("decimal comma", () => {
    expect(val("12,5")).toBe(12.5);
    expect(val("1234,56")).toBe(1234.56);
  });
  test("dot thousands + comma decimal (de/fr)", () => {
    expect(val("1.234,56")).toBe(1234.56);
    expect(val("1.234.567,89")).toBe(1234567.89);
    expect(val("€1.299,00")).toBe(1299);
  });
  test("space thousands", () => {
    expect(val("1 234,56")).toBe(1234.56);
    expect(val("1 234 567")).toBe(1234567);
  });
  test("accounting parens + trailing minus = negative", () => {
    expect(val("(123.45)")).toBe(-123.45);
    expect(val("(1,234.50)")).toBe(-1234.5);
    expect(val("123.45-")).toBe(-123.45);
  });
  test("multi-group dot thousands", () => {
    expect(val("1.234.567")).toBe(1234567);
  });
  test("lone dot stays decimal (ambiguous → no new corruption)", () => {
    expect(val("1.234")).toBe(1.234);
    expect(val("1.500")).toBe(1.5);
  });
  test("flags normalization when a non-US convention was applied", () => {
    expect(parseDecimal("1.234,56")!.normalized).toBe(true);
    expect(parseDecimal("12.99")!.normalized).toBe(false);
  });
});
