import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.75;

// Match <script ... id="__ALGOLIA_DATA__" ...>...</script>
// Covers both type="application/json" and plain <script> tags
const ALGOLIA_SCRIPT_RE =
  /<script[^>]*\bid=["']__ALGOLIA_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

export function parseAlgolia(html: string): ParserOutput {
  const m = html.match(ALGOLIA_SCRIPT_RE);
  if (!m) {
    return { kind: "algolia", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  const jsonText = m[1]!.trim();
  if (!jsonText) {
    return { kind: "algolia", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { kind: "algolia", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  if (!isRecord(data)) {
    return { kind: "algolia", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  // Take the first hit from the hits array
  const hits = data["hits"];
  if (!Array.isArray(hits) || hits.length === 0) {
    return { kind: "algolia", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  const firstHit = hits[0];
  if (!isRecord(firstHit)) {
    return { kind: "algolia", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  const facts = extractHit(firstHit, hits.length);
  return {
    kind: "algolia",
    facts,
    baselineConfidence: BASELINE_CONFIDENCE,
    diagnostics: { totalHits: hits.length },
  };
}

function extractHit(hit: Record<string, unknown>, totalHits: number): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  // title: name | title
  const titleVal = pickFirst(hit, ["name", "title"]);
  pushString(facts, "title", titleVal, "algolia:hits[0].name");

  // brand: brand | vendor
  const brandVal = pickFirst(hit, ["brand", "vendor"]);
  pushString(facts, "brand", brandVal, "algolia:hits[0].brand");

  // base_price: price
  pushNumber(facts, "base_price", hit["price"], "algolia:hits[0].price");

  // gtin
  pushString(facts, "gtin", hit["gtin"], "algolia:hits[0].gtin");

  // model_number: mpn | sku
  const mpnVal = pickFirst(hit, ["mpn", "sku"]);
  pushString(facts, "model_number", mpnVal, "algolia:hits[0].mpn");

  // description
  pushString(facts, "description", hit["description"], "algolia:hits[0].description");

  void totalHits; // used in diagnostics only
  return facts;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pickFirst(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] != null) return obj[k];
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function makeFact(rawKey: string, extractedValue: unknown, sourcePointer: string): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue,
    normalizedValue: null,
    unit: null,
    sourcePointer,
    extractionMethod: "direct",
    confidence: BASELINE_CONFIDENCE,
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    approved: false,
  };
}

function pushString(
  facts: ExtractedFact[],
  rawKey: string,
  value: unknown,
  sourcePointer: string
): void {
  if (typeof value !== "string" || !value.trim()) return;
  facts.push(makeFact(rawKey, value, sourcePointer));
}

function pushNumber(
  facts: ExtractedFact[],
  rawKey: string,
  value: unknown,
  sourcePointer: string
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    facts.push(makeFact(rawKey, value, sourcePointer));
    return;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) facts.push(makeFact(rawKey, n, sourcePointer));
  }
}
