import { describe, expect, test } from "bun:test";
import { gtinCheckDigit, gtinIssue, isValidGtin } from "./gtin.js";

/** Build a checksum-valid GTIN of a given length from a numeric base. */
function makeValid(base: string, length: number): string {
  const body = base.padStart(length - 1, "0").slice(0, length - 1);
  const digits = body.split("").map(Number);
  return body + String(gtinCheckDigit(digits));
}

describe("gtin validation (GS1 mod-10)", () => {
  test("accepts checksum-valid GTIN-8/12/13/14", () => {
    for (const len of [8, 12, 13, 14]) {
      const g = makeValid("123456789012345", len);
      expect(g.length).toBe(len);
      expect(isValidGtin(g)).toBe(true);
      expect(gtinIssue(g)).toBeNull();
    }
  });

  test("known real barcodes validate", () => {
    expect(isValidGtin("4006381333931")).toBe(true); // EAN-13
    expect(isValidGtin("036000291452")).toBe(true); // UPC-A
    expect(isValidGtin("73513537")).toBe(true); // EAN-8
  });

  test("rejects a wrong check digit as checksum (right length, all digits)", () => {
    const good = makeValid("5901234123456", 13);
    const bad = good.slice(0, -1) + String((Number(good.slice(-1)) + 1) % 10);
    expect(gtinIssue(bad)).toBe("checksum");
    expect(isValidGtin(bad)).toBe(false);
  });

  test("rejects non-digits and wrong lengths as format", () => {
    expect(gtinIssue("invalid123")).toBe("format");
    expect(gtinIssue("123")).toBe("format"); // too short
    expect(gtinIssue("123456789")).toBe("format"); // 9 digits — not a GTIN length
  });
});
