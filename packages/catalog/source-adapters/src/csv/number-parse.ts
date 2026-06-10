// Locale-aware decimal parsing for CSV money/quantity columns.
//
// The old cleanNumeric() did `replace(/[^0-9.-]/g, "")`, which silently
// CORRUPTS every non-US format a real merchant uploads:
//   "1.234,56"  (de/fr) -> "1.234.56" -> NaN
//   "1 234,56"  (fr)     -> "123456"   (off by 100×)
//   "12,5"      (eu)     -> "125"      (off by 10×)
//   "(123.45)"  (acct)   -> "123.45"   (sign dropped — a refund becomes a charge)
// A wrong price is worse than a rejected one, so this parser disambiguates the
// decimal separator instead of deleting it.
//
// Strategy: strip currency/letters/whitespace, honour accounting parens as
// negative, then decide the decimal mark:
//   - both "." and "," present -> the LAST one is the decimal, the other groups
//   - one separator present     -> a strict thousands pattern (\d{1,3}(sep\d{3})+)
//                                  is grouping; otherwise it's the decimal mark
// Returns null when there is no parseable number (caller decides to reject).

export interface ParsedNumber {
  value: number;
  /** True when the input used a non-US convention we had to normalize. */
  normalized: boolean;
}

const THOUSANDS_COMMA = /^\d{1,3}(,\d{3})+$/;
// Dots are read as grouping ONLY with 2+ groups ("1.234.567"). A lone dot stays
// a decimal — a single "1.234"/"1.500" is ambiguous and US/most-locale default is
// decimal; reading it as thousands would newly corrupt weights and 3dp prices.
const THOUSANDS_DOT = /^\d{1,3}(\.\d{3}){2,}$/;

export function parseDecimal(raw: string): ParsedNumber | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s === "") return null;

  // Accounting negative: "(123.45)" or "(1,234)".
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Explicit leading/trailing sign.
  if (/^[+-]/.test(s)) {
    if (s[0] === "-") negative = !negative;
    s = s.slice(1).trim();
  } else if (/[-]$/.test(s)) {
    // trailing minus (some accounting exports): "123.45-"
    negative = !negative;
    s = s.slice(0, -1).trim();
  }

  // Drop everything that isn't a digit or a separator (currency, %, NBSP, letters…).
  const original = s;
  s = s.replace(/[^0-9.,]/g, "");
  if (s === "" || !/\d/.test(s)) return null;

  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  let normalized = original !== s || negative;

  if (hasDot && hasComma) {
    // The rightmost separator is the decimal mark; the other is grouping.
    const decimal = s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
    const grouping = decimal === "." ? "," : ".";
    s = s.split(grouping).join("");
    if (decimal === ",") s = s.replace(",", ".");
    normalized = true;
  } else if (hasComma) {
    if (THOUSANDS_COMMA.test(s)) {
      s = s.split(",").join(""); // pure grouping: 1,234,567
    } else {
      s = s.replace(",", "."); // decimal comma: 12,5
      normalized = true;
    }
  } else if (hasDot) {
    if (THOUSANDS_DOT.test(s)) {
      s = s.split(".").join(""); // pure grouping: 1.234.567
      normalized = true;
    }
    // else: single/standard dot decimal — leave as-is.
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return { value: negative ? -n : n, normalized };
}
