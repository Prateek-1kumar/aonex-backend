// GTIN validation — GS1 standard, not just a length check.
//
// The single shared implementation (previously duplicated in the CSV source
// adapter and @aonex/ingestion-enrichment's sanity validators, with the
// latter accepting non-GS1 lengths 9-11). A real GTIN is exactly 8/12/13/14
// digits and carries a mod-10 check digit; validating both catches the
// overwhelming majority of transposed/typo'd barcodes at ingestion.

export type GtinIssue = "format" | "checksum";

const VALID_LENGTHS = new Set([8, 12, 13, 14]);

/** GS1 mod-10: from the rightmost data digit, weight alternates 3,1,3,1…; the
 *  check digit makes the weighted sum a multiple of 10. */
export function gtinCheckDigit(dataDigits: number[]): number {
  let sum = 0;
  for (let i = dataDigits.length - 1, mul = 3; i >= 0; i--, mul = mul === 3 ? 1 : 3) {
    sum += dataDigits[i]! * mul;
  }
  return (10 - (sum % 10)) % 10;
}

/** Returns null when the GTIN is well-formed AND checksum-valid; otherwise the
 *  specific reason so the caller can warn precisely. */
export function gtinIssue(gtin: string): GtinIssue | null {
  if (!/^\d+$/.test(gtin) || !VALID_LENGTHS.has(gtin.length)) return "format";
  const digits = gtin.split("").map(Number);
  const check = digits.pop()!;
  return gtinCheckDigit(digits) === check ? null : "checksum";
}

export function isValidGtin(gtin: string): boolean {
  return gtinIssue(gtin) === null;
}
