import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.85;

// Broad keyset for shape-based discovery. Covers Bewakoof/Myntra (mrp,
// breadCrumb, sizes), Shopify Hydrogen (title, vendor, variants, options),
// and generic ecommerce (sellingPrice, listPrice, skus).
const PRODUCT_FIELD_KEYS = new Set([
  "name",
  "title",
  "productName",
  "displayName",
  "price",
  "sellingPrice",
  "listPrice",
  "salePrice",
  "mrp",
  "amount",
  "priceValue",
  "discountedPrice",
  "sku",
  "skus",
  "gtin",
  "barcode",
  "brand",
  "vendor",
  "manufacturer",
  "sizes",
  "variants",
  "options",
  "colors",
  "description",
  "shortDescription",
  "images",
  "media",
  "photos",
  "breadCrumb",
  "breadcrumb",
  "breadcrumbs",
  "category",
  "categoryPath",
  "color",
  "material",
]);

export function parseNextData(
  data: Record<string, unknown> | null
): ParserOutput {
  if (!data)
    return { kind: "next_data", facts: [], baselineConfidence: BASELINE_CONFIDENCE };

  // Shopify Hydrogen has a stable shape under props.pageProps.product (or
  // initialState.product) with variants.nodes[] + selectedOptions[]. Try this
  // before generic discovery — it lets us extract real per-variant axes.
  const hydrogen = findShopifyHydrogenProduct(data);
  if (hydrogen) {
    return {
      kind: "next_data",
      facts: extractHydrogen(hydrogen),
      baselineConfidence: BASELINE_CONFIDENCE,
    };
  }

  const pd = findProductDetails(data);
  if (!pd)
    return { kind: "next_data", facts: [], baselineConfidence: BASELINE_CONFIDENCE };

  return {
    kind: "next_data",
    facts: extractGeneric(pd),
    baselineConfidence: BASELINE_CONFIDENCE,
  };
}

// ── Shopify Hydrogen ─────────────────────────────────────────────────

function findShopifyHydrogenProduct(
  root: Record<string, unknown>
): Record<string, unknown> | null {
  const paths: string[][] = [
    ["props", "pageProps", "product"],
    ["props", "pageProps", "shop", "product"],
    ["props", "initialState", "product"],
    ["props", "pageProps", "data", "product"],
  ];
  for (const p of paths) {
    const node = pickPath(root, p);
    if (isHydrogenProduct(node)) return node;
  }
  return null;
}

function isHydrogenProduct(node: unknown): node is Record<string, unknown> {
  if (!isRecord(node)) return false;
  // Hydrogen v2: variants.nodes[]; Hydrogen v1: variants is a plain array.
  const variants = node.variants;
  if (isRecord(variants) && Array.isArray(variants.nodes)) return true;
  if (Array.isArray(variants) && variants.length > 0 && isRecord(variants[0])) {
    // Check that variant items look hydrogen-ish (selectedOptions or price shape)
    const v = variants[0] as Record<string, unknown>;
    return Array.isArray(v.selectedOptions) || isRecord(v.price);
  }
  return false;
}

function extractHydrogen(product: Record<string, unknown>): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  pushString(facts, "title", product.title);
  pushString(facts, "brand", product.vendor);
  pushString(facts, "description", product.description);

  const variantList = pickHydrogenVariants(product);
  let topCurrency: string | null = null;

  variantList.forEach((v, i) => {
    pushStringOrNumber(facts, `variants[${i}].sku`, v.sku);

    const selOpts = Array.isArray(v.selectedOptions) ? v.selectedOptions : [];
    for (const opt of selOpts) {
      if (!isRecord(opt)) continue;
      const axisName = typeof opt.name === "string" ? opt.name : null;
      const axisValue = typeof opt.value === "string" ? opt.value : null;
      if (!axisName || !axisValue) continue;
      const axis = axisName.toLowerCase();
      facts.push(makeFact(`variants[${i}].option.${axis}`, axisValue, axisValue));
    }

    // Hydrogen v2: price is { amount, currencyCode }; some shops store amount as string
    if (isRecord(v.price)) {
      const amount =
        typeof v.price.amount === "number"
          ? v.price.amount
          : typeof v.price.amount === "string"
            ? Number(v.price.amount)
            : null;
      if (amount != null && Number.isFinite(amount)) {
        facts.push(makeFact(`variants[${i}].price`, amount, amount));
      }
      if (typeof v.price.currencyCode === "string" && !topCurrency) {
        topCurrency = v.price.currencyCode;
      }
    } else if (typeof v.price === "number") {
      facts.push(makeFact(`variants[${i}].price`, v.price, v.price));
    }

    if (typeof v.quantityAvailable === "number") {
      facts.push(
        makeFact(
          `variants[${i}].inventory_quantity`,
          v.quantityAvailable,
          v.quantityAvailable
        )
      );
    }
  });

  if (topCurrency) {
    facts.push(makeFact("currency", topCurrency, topCurrency));
  }

  return facts;
}

function pickHydrogenVariants(
  product: Record<string, unknown>
): Record<string, unknown>[] {
  const variants = product.variants;
  if (isRecord(variants) && Array.isArray(variants.nodes)) {
    return variants.nodes.filter(isRecord);
  }
  if (Array.isArray(variants)) {
    return variants.filter(isRecord);
  }
  return [];
}

// ── Generic (Bewakoof + non-Hydrogen) ─────────────────────────────────

function extractGeneric(pd: Record<string, unknown>): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  // Core fields
  pushString(facts, "title", pickFirst(pd, ["name", "title", "productName", "displayName"]));
  const price = pickFirst(pd, [
    "price",
    "sellingPrice",
    "salePrice",
    "discountedPrice",
    "amount",
    "priceValue",
  ]);
  pushNumber(facts, "base_price", price);
  pushNumber(facts, "mrp", pickFirst(pd, ["mrp", "listPrice"]));
  pushString(facts, "description", pd.description);

  // Color (top-level — variants may also have per-item colors)
  const color = pickStringDeep(pd, ["color", "name"]);
  if (color) facts.push(makeFact("color", color, color));
  else if (typeof pd.color === "string") pushString(facts, "color", pd.color);

  // Brand
  const brand = pickFirst(pd, ["brand", "vendor", "manufacturer"]);
  if (typeof brand === "string") {
    pushString(facts, "brand", brand);
  } else if (isRecord(brand)) {
    pushString(facts, "brand", brand.name as string | undefined);
  }

  // Breadcrumb → productType
  const crumbsRaw =
    (Array.isArray(pd.breadCrumb) && pd.breadCrumb) ||
    (Array.isArray(pd.breadcrumb) && pd.breadcrumb) ||
    (Array.isArray(pd.breadcrumbs) && pd.breadcrumbs) ||
    null;
  if (crumbsRaw) {
    const crumbNames = (crumbsRaw as Record<string, unknown>[])
      .map((c) => (typeof c.name === "string" ? c.name : null))
      .filter((s): s is string => s != null);
    if (crumbNames.length > 0) {
      const path = crumbNames
        .map((s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
        .join("/");
      facts.push(makeFact("productType", path, path));
    }
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

  // Variants: try sizes[] (Bewakoof), then skus[] (generic), then variants[]
  const variantList =
    (Array.isArray(pd.sizes) && (pd.sizes as Record<string, unknown>[])) ||
    (Array.isArray(pd.skus) && (pd.skus as Record<string, unknown>[])) ||
    (Array.isArray(pd.variants) && (pd.variants as Record<string, unknown>[])) ||
    [];

  variantList.forEach((s, i) => {
    // Bewakoof: { name, product_variant_id, qty_avail }
    if (typeof s.name === "string")
      facts.push(makeFact(`variants[${i}].option.size`, s.name, s.name));
    if (typeof s.optionLabel === "string")
      facts.push(
        makeFact(`variants[${i}].option.size`, s.optionLabel, s.optionLabel)
      );

    const sku =
      (typeof s.product_variant_id !== "undefined" && s.product_variant_id) ||
      s.sku ||
      s.id ||
      null;
    if (sku != null) {
      const skuStr = String(sku);
      facts.push(makeFact(`variants[${i}].sku`, skuStr, skuStr));
    }

    if (s.qty_avail != null) {
      const n = Number(s.qty_avail);
      if (Number.isFinite(n))
        facts.push(makeFact(`variants[${i}].inventory_quantity`, n, n));
    } else if (typeof s.inventoryQuantity === "number") {
      facts.push(
        makeFact(`variants[${i}].inventory_quantity`, s.inventoryQuantity, s.inventoryQuantity)
      );
    }
  });

  return facts;
}

/** Walk the props tree looking for the subtree whose keys most resemble a product. */
function findProductDetails(
  root: Record<string, unknown>,
  maxDepth = 8
): Record<string, unknown> | null {
  type Candidate = { obj: Record<string, unknown>; score: number };
  let best: Candidate | null = null;
  function walk(obj: unknown, depth: number) {
    if (depth > maxDepth || !isRecord(obj)) return;
    const score = Object.keys(obj).filter((k) =>
      PRODUCT_FIELD_KEYS.has(k)
    ).length;
    // Require at least one name-like key AND one price-like key to qualify.
    const hasName = ["name", "title", "productName", "displayName"].some(
      (k) => typeof obj[k] === "string"
    );
    const hasPriceLike = [
      "price",
      "sellingPrice",
      "listPrice",
      "salePrice",
      "mrp",
      "amount",
      "priceValue",
      "discountedPrice",
    ].some((k) => isNumericLike(obj[k]));
    if (score >= 3 && hasName && hasPriceLike) {
      const current: Candidate | null = best;
      if (!current || score > current.score) best = { obj, score };
    }
    for (const v of Object.values(obj)) {
      if (isRecord(v)) walk(v, depth + 1);
      else if (Array.isArray(v)) {
        for (const item of v) if (isRecord(item)) walk(item, depth + 1);
      }
    }
  }
  walk(root, 0);
  // TS narrows closure-mutated `best` to its initial type; cast preserves it.
  const result = best as Candidate | null;
  return result ? result.obj : null;
}

function isNumericLike(v: unknown): boolean {
  if (typeof v === "number" && Number.isFinite(v)) return true;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return true;
  return false;
}

function pickFirst(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] != null) return obj[k];
  return null;
}

function pickPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
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

function pushStringOrNumber(
  facts: ExtractedFact[],
  rawKey: string,
  value: unknown
): void {
  if (value == null) return;
  if (typeof value === "string" && value.trim()) {
    facts.push(makeFact(rawKey, value, value));
  } else if (typeof value === "number") {
    const s = String(value);
    facts.push(makeFact(rawKey, s, s));
  }
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
    sourceAlternatives: null,
    approved: false,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
