import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.95;

export function parseJsonLd(blocks: Record<string, unknown>[]): ParserOutput {
  const facts: ExtractedFact[] = [];
  const products = pickProducts(blocks);
  const breadcrumb = pickBreadcrumb(blocks);

  // Prefer the most complete Product block (one with .size[] over the other)
  const product = pickBestProduct(products);
  if (product) {
    pushString(facts, "title", product.name);
    const brand = isRecord(product.brand)
      ? (product.brand.name as string)
      : (product.brand as string | undefined);
    pushString(facts, "brand", brand);
    pushStringOrNumber(facts, "gtin", product.gtin);
    pushStringOrNumber(facts, "mpn", product.mpn);
    pushStringOrNumber(facts, "model_number", product.model);
    pushString(facts, "description", product.description as string | undefined);

    const offers = pickFirstOffer(product.offers);
    if (offers) {
      pushNumber(facts, "base_price", offers.price);
      pushString(facts, "currency", offers.priceCurrency as string | undefined);
    }

    // Images
    const images = normalizeImages(product.image);
    if (images.length > 0) {
      facts.push(makeFact("images", images, images));
    }

    // Variant sizes
    const sizes = pickSizeArray(product.size);
    if (sizes.length > 0) {
      sizes.forEach((s, i) => {
        facts.push(makeFact(`variants[${i}].option.size`, s, s));
      });
    }
  }

  if (breadcrumb) {
    facts.push(makeFact("productType", breadcrumb, breadcrumb));
  }

  return {
    kind: "json_ld",
    facts,
    baselineConfidence: BASELINE_CONFIDENCE,
  };
}

function pickProducts(blocks: Record<string, unknown>[]): Record<string, unknown>[] {
  return blocks.filter((b) => b["@type"] === "Product");
}

function pickBestProduct(
  products: Record<string, unknown>[]
): Record<string, unknown> | null {
  if (products.length === 0) return null;
  // Heuristic: prefer the one with size[] then with offers.
  return (
    products.find((p) => Array.isArray(p.size) && (p.size as unknown[]).length > 0) ??
    products.find((p) => p.offers != null) ??
    products[0]!
  );
}

function pickBreadcrumb(blocks: Record<string, unknown>[]): string | null {
  const b = blocks.find((x) => x["@type"] === "BreadcrumbList");
  if (!b) return null;
  const items = b.itemListElement as Record<string, unknown>[] | undefined;
  if (!Array.isArray(items)) return null;
  const names = items
    .map((i) => (typeof i.name === "string" ? i.name : null))
    .filter((n): n is string => n != null);
  if (names.length === 0) return null;
  return names.join("/");
}

function pickFirstOffer(offers: unknown): Record<string, unknown> | null {
  if (Array.isArray(offers)) {
    return (offers[0] as Record<string, unknown>) ?? null;
  }
  if (isRecord(offers)) {
    if (offers["@type"] === "AggregateOffer" && Array.isArray(offers.offers)) {
      return (offers.offers[0] as Record<string, unknown>) ?? null;
    }
    return offers;
  }
  return null;
}

function normalizeImages(
  raw: unknown
): { url: string; altText: string | null }[] {
  const urls: string[] = [];
  if (typeof raw === "string") urls.push(raw);
  else if (Array.isArray(raw))
    for (const r of raw) {
      if (typeof r === "string") urls.push(r);
      else if (isRecord(r) && typeof r.url === "string") urls.push(r.url);
    }
  return urls
    .filter((u) => u.startsWith("http"))
    .map((url) => ({ url, altText: null }));
}

function pickSizeArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (typeof raw === "string") return [raw];
  return [];
}

function pushString(
  facts: ExtractedFact[],
  rawKey: string,
  value: unknown
): void {
  if (typeof value !== "string" || !value.trim()) return;
  facts.push(makeFact(rawKey, value, value));
}

/** Push a field that may be a string or number — always coerce to string. */
function pushStringOrNumber(
  facts: ExtractedFact[],
  rawKey: string,
  value: unknown
): void {
  if (value == null) return;
  if (typeof value === "string") {
    if (!value.trim()) return;
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
  if (typeof value === "number") {
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
    sourcePointer: `jsonld:Product.${rawKey}`,
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
