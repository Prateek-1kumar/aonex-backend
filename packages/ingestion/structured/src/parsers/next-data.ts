import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.85;

const PRODUCT_FIELD_KEYS = new Set([
  "name",
  "title",
  "price",
  "mrp",
  "sku",
  "brand",
  "sizes",
  "color",
  "images",
  "breadCrumb",
  "description",
]);

export function parseNextData(
  data: Record<string, unknown> | null
): ParserOutput {
  if (!data) return { kind: "next_data", facts: [], baselineConfidence: BASELINE_CONFIDENCE };

  const pd = findProductDetails(data);
  const facts: ExtractedFact[] = [];
  if (!pd) return { kind: "next_data", facts, baselineConfidence: BASELINE_CONFIDENCE };

  // Core fields
  pushString(facts, "title", pickFirst(pd, ["name", "title"]));
  pushNumber(facts, "base_price", pd.price);
  pushNumber(facts, "mrp", pd.mrp);
  pushString(facts, "description", pd.description);

  // Color
  const color = pickStringDeep(pd, ["color", "name"]);
  if (color) facts.push(makeFact("color", color, color));

  // Brand
  if (typeof pd.brand === "string") {
    pushString(facts, "brand", pd.brand);
  } else if (isRecord(pd.brand)) {
    pushString(facts, "brand", pd.brand.name as string | undefined);
  }

  // Breadcrumb → productType
  const crumbs = Array.isArray(pd.breadCrumb)
    ? (pd.breadCrumb as Record<string, unknown>[])
    : [];
  const crumbNames = crumbs
    .map((c) => (typeof c.name === "string" ? c.name : null))
    .filter((s): s is string => s != null);
  if (crumbNames.length > 0) {
    const path = crumbNames
      .map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
      .join("/");
    facts.push(makeFact("productType", path, path));
  }

  // Images
  const imgRoot = isRecord(pd.images) ? pd.images : null;
  if (imgRoot) {
    const all: { url: string; altText: string | null }[] = [];
    for (const k of ["original", "display", "additional"]) {
      const arr = imgRoot[k];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (isRecord(item) && typeof item.url === "string") {
            all.push({ url: item.url, altText: null });
          }
        }
      }
    }
    if (all.length > 0) {
      facts.push(makeFact("images", all, all));
    }
  }

  // Variants: per-size objects
  const sizes = Array.isArray(pd.sizes) ? (pd.sizes as Record<string, unknown>[]) : [];
  sizes.forEach((s, i) => {
    if (typeof s.name === "string")
      facts.push(makeFact(`variants[${i}].option.size`, s.name, s.name));
    if (s.product_variant_id != null) {
      const sku = String(s.product_variant_id);
      facts.push(makeFact(`variants[${i}].sku`, sku, sku));
    }
    if (s.qty_avail != null) {
      const n = Number(s.qty_avail);
      if (Number.isFinite(n))
        facts.push(makeFact(`variants[${i}].inventory_quantity`, n, n));
    }
  });

  return { kind: "next_data", facts, baselineConfidence: BASELINE_CONFIDENCE };
}

/** Walk the props tree looking for the subtree whose keys most resemble a product. */
function findProductDetails(
  root: Record<string, unknown>,
  maxDepth = 6
): Record<string, unknown> | null {
  let best: { obj: Record<string, unknown>; score: number } | null = null;
  function walk(obj: unknown, depth: number) {
    if (depth > maxDepth || !isRecord(obj)) return;
    const score = Object.keys(obj).filter((k) =>
      PRODUCT_FIELD_KEYS.has(k)
    ).length;
    if (score >= 4) {
      if (!best || score > best.score) best = { obj, score };
    }
    for (const v of Object.values(obj)) {
      if (isRecord(v)) walk(v, depth + 1);
    }
  }
  walk(root, 0);
  return best ? best.obj : null;
}

function pickFirst(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] != null) return obj[k];
  return null;
}

function pickStringDeep(obj: unknown, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const seg of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[seg];
  }
  return typeof cur === "string" ? cur : undefined;
}

function pushString(
  facts: ExtractedFact[],
  rawKey: string,
  value: unknown
): void {
  if (typeof value !== "string" || !value.trim()) return;
  facts.push(makeFact(rawKey, value, value));
}

function pushNumber(
  facts: ExtractedFact[],
  rawKey: string,
  value: unknown
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    facts.push(makeFact(rawKey, value, value));
    return;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) facts.push(makeFact(rawKey, n, n));
  }
}

function makeFact(
  rawKey: string,
  extractedValue: unknown,
  normalizedValue: unknown
): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue,
    normalizedValue,
    unit: null,
    sourcePointer: `next_data:productDetails.${rawKey}`,
    extractionMethod: "direct",
    confidence: BASELINE_CONFIDENCE,
    mappingMethod: null,
    mappingCandidates: null,
    approved: false,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

