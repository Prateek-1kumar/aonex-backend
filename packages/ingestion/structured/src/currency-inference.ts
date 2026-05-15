import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

const INFERENCE_CONFIDENCE = 0.70;

/**
 * ccTLD → ISO-4217 currency map.
 * Deliberately conservative: only common TLDs with unambiguous currency mappings.
 * `.com`, `.co`, `.io`, etc. are intentionally absent — they yield no inference,
 * so the currency stays a gap that downstream stages (LLM gap-fill or review) handle.
 */
const TLD_CURRENCY: Record<string, string> = {
  in: "INR",
  au: "AUD",
  uk: "GBP", // matches "co.uk" via the .uk suffix check below
  ca: "CAD",
  jp: "JPY",
  de: "EUR",
  fr: "EUR",
  it: "EUR",
  es: "EUR",
  nl: "EUR",
  ie: "EUR",
  nz: "NZD",
  ch: "CHF",
  se: "SEK",
  no: "NOK",
  dk: "DKK",
  sg: "SGD",
};

export function inferCurrency(
  pageUrl: string,
  existingFacts: ExtractedFact[]
): ExtractedFact | null {
  // No-op if currency already extracted by any parser.
  if (existingFacts.some((f) => f.rawKey === "currency")) return null;

  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  const tld = host.split(".").pop();
  if (!tld) return null;
  const currency = TLD_CURRENCY[tld];
  if (!currency) return null;

  return {
    rawKey: "currency",
    canonicalPath: null,
    extractedValue: currency,
    normalizedValue: currency,
    unit: null,
    sourcePointer: `tld_inference:${host}`,
    extractionMethod: "inferred",
    confidence: INFERENCE_CONFIDENCE,
    mappingMethod: null,
    mappingCandidates: null,
    approved: false,
  };
}
