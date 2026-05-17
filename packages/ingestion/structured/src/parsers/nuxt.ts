import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.85;

// Non-greedy match of window.__NUXT__={...} across newlines
const NUXT_RE = /window\.__NUXT__\s*=\s*([\s\S]*?);?\s*<\/script>/i;

/** Candidate paths inside the __NUXT__ payload where product data may live */
const PRODUCT_PATHS: string[][] = [
  ["payload", "product"],
  ["payload", "state", "product"],
  ["payload", "data", "product"],
  ["payload", "pageProps", "product"],
];

export function parseNuxt(html: string): ParserOutput {
  const m = html.match(NUXT_RE);
  if (!m) return { kind: "nuxt", facts: [], baselineConfidence: BASELINE_CONFIDENCE };

  let payload: unknown;
  try {
    payload = JSON.parse(m[1]!);
  } catch {
    return { kind: "nuxt", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  if (!isRecord(payload)) {
    return { kind: "nuxt", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  const product = findProduct(payload);
  if (!product) {
    return { kind: "nuxt", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
  }

  const facts = extractProduct(product);
  return {
    kind: "nuxt",
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
  pushString(facts, "title", titleVal, "nuxt:product.name");

  // brand: brand | vendor
  const brandVal = pickFirst(product, ["brand", "vendor"]);
  pushString(facts, "brand", brandVal, "nuxt:product.brand");

  // base_price: price | sellingPrice (must be numeric)
  const priceVal = pickFirst(product, ["price", "sellingPrice"]);
  pushNumber(facts, "base_price", priceVal, "nuxt:product.price");

  // gtin: gtin | barcode
  const gtinVal = pickFirst(product, ["gtin", "barcode"]);
  pushString(facts, "gtin", gtinVal, "nuxt:product.gtin");

  // model_number: mpn | model
  const mpnVal = pickFirst(product, ["mpn", "model"]);
  pushString(facts, "model_number", mpnVal, "nuxt:product.mpn");

  // description
  pushString(facts, "description", product["description"], "nuxt:product.description");

  // Flatten product.attributes object into individual facts
  const attrs = product["attributes"];
  if (isRecord(attrs)) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        facts.push(makeFact(key, value, `nuxt:product.attributes.${key}`));
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
