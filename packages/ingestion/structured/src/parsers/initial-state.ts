import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.80;

// Match window.__INITIAL_STATE__={...} or window.__PRELOADED_STATE__={...}
const INITIAL_STATE_RE = /window\.__(?:INITIAL_STATE|PRELOADED_STATE)__\s*=\s*([\s\S]*?);?\s*<\/script>/i;

/** Candidate paths inside the state payload where product data may live */
const PRODUCT_PATHS: string[][] = [
  ["product"],
  ["state", "product"],
  ["data", "product"],
  ["pageProps", "product"],
  ["payload", "product"],
  ["payload", "state", "product"],
  ["payload", "data", "product"],
  ["payload", "pageProps", "product"],
];

export function parseInitialState(html: string): ParserOutput {
  const m = html.match(INITIAL_STATE_RE);
  if (!m) {
    return { kind: "initial_state", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(m[1]!);
  } catch {
    return { kind: "initial_state", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  if (!isRecord(payload)) {
    return { kind: "initial_state", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  const product = findProduct(payload);
  if (!product) {
    return { kind: "initial_state", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  const facts = extractProduct(product);
  return {
    kind: "initial_state",
    facts,
    baselineConfidence: BASELINE_CONFIDENCE,
    diagnostics: { candidatePaths: PRODUCT_PATHS.length },
  };
}

function findProduct(root: Record<string, unknown>): Record<string, unknown> | null {
  for (const path of PRODUCT_PATHS) {
    const node = pickPath(root, path);
    if (isRecord(node)) return node;
  }
  return null;
}

function extractProduct(product: Record<string, unknown>): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  // title: name | title
  const titleVal = pickFirst(product, ["name", "title"]);
  pushString(facts, "title", titleVal, "initial_state:product.name");

  // brand: brand | vendor
  const brandVal = pickFirst(product, ["brand", "vendor"]);
  pushString(facts, "brand", brandVal, "initial_state:product.brand");

  // base_price: price | sellingPrice
  const priceVal = pickFirst(product, ["price", "sellingPrice"]);
  pushNumber(facts, "base_price", priceVal, "initial_state:product.price");

  // gtin: gtin | barcode
  const gtinVal = pickFirst(product, ["gtin", "barcode"]);
  pushString(facts, "gtin", gtinVal, "initial_state:product.gtin");

  // model_number: mpn | model
  const mpnVal = pickFirst(product, ["mpn", "model"]);
  pushString(facts, "model_number", mpnVal, "initial_state:product.mpn");

  // description
  pushString(facts, "description", product["description"], "initial_state:product.description");

  // Flatten product.attributes object into individual facts
  const attrs = product["attributes"];
  if (isRecord(attrs)) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        facts.push(makeFact(key, value, `initial_state:product.attributes.${key}`));
      }
    }
  }

  return facts;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function pickPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

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
