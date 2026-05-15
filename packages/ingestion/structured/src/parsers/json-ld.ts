import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.95;

export interface ParseJsonLdOptions {
  /**
   * Page URL — used to infer the page's preferred currency from the TLD
   * (`.au → AUD`, `.in → INR`, etc.) when picking among multi-currency offers.
   */
  pageUrl?: string;
}

export function parseJsonLd(
  blocks: Record<string, unknown>[],
  options: ParseJsonLdOptions = {}
): ParserOutput {
  const facts: ExtractedFact[] = [];
  const productGroup = pickProductGroup(blocks);
  const products = pickProducts(blocks);
  const preferredCurrency = options.pageUrl ? currencyFromUrl(options.pageUrl) : null;

  // ProductGroup wins for product-family-level fields when present.
  // Falls back to a standalone Product block otherwise.
  const topLevel: Record<string, unknown> | null =
    productGroup ?? pickBestProduct(products);

  if (topLevel) {
    pushString(facts, "title", topLevel.name);
    const brand = isRecord(topLevel.brand)
      ? (topLevel.brand.name as string)
      : (topLevel.brand as string | undefined);
    pushString(facts, "brand", brand);

    // GTIN: prefer the most specific subtype (gtin13/14/12/8) but record
    // which one in the sourcePointer so callers can audit.
    const gtinPick = pickGtin(topLevel);
    if (gtinPick) {
      facts.push({
        ...makeFact("gtin", gtinPick.value, gtinPick.value),
        sourcePointer: `jsonld:Product.${gtinPick.subtype}`,
      });
    }

    pushStringOrNumber(facts, "sku", topLevel.sku);
    pushStringOrNumber(facts, "mpn", topLevel.mpn);
    pushStringOrNumber(facts, "model_number", topLevel.model);
    pushString(facts, "description", topLevel.description as string | undefined);

    // Standard schema.org Product attributes.
    pushString(facts, "color", topLevel.color);
    pushString(facts, "material", topLevel.material);
    pushString(facts, "weight", topLevel.weight);
    pushString(facts, "pattern", topLevel.pattern);

    const audience = isRecord(topLevel.audience) ? topLevel.audience : null;
    if (audience) {
      pushString(facts, "gender", audience.suggestedGender);
    }

    const rating = isRecord(topLevel.aggregateRating)
      ? topLevel.aggregateRating
      : null;
    if (rating) {
      pushNumber(facts, "rating", rating.ratingValue);
      pushNumber(facts, "review_count", rating.reviewCount);
    }

    // additionalProperty[] — where most brands stuff specs.
    const additional = Array.isArray(topLevel.additionalProperty)
      ? (topLevel.additionalProperty as unknown[])
      : [];
    for (const entry of additional) {
      if (!isRecord(entry)) continue;
      const name = typeof entry.name === "string" ? entry.name : null;
      const value = entry.value ?? entry.unitText;
      if (!name || value == null) continue;
      const slug = slugifyKey(name);
      if (!slug) continue;
      facts.push({
        ...makeFact(slug, value, value),
        sourcePointer: `jsonld:Product.additionalProperty[${JSON.stringify(name)}]`,
      });
    }

    const offers = pickFirstOffer(topLevel.offers, preferredCurrency);
    if (offers) {
      pushNumber(facts, "base_price", offers.price);
      pushString(facts, "currency", offers.priceCurrency as string | undefined);
    }

    const images = normalizeImages(topLevel.image);
    if (images.length > 0) {
      facts.push(makeFact("images", images, images));
    }
  }

  // Variant emission: prefer ProductGroup.hasVariant[] children when present
  // (multi-axis matrices: color × size). Falls back to the legacy
  // Product.size[] flat list when there is no ProductGroup.
  const variantChildren = productGroup ? pickHasVariantChildren(productGroup) : [];
  if (variantChildren.length > 0) {
    variantChildren.forEach((child, i) => {
      pushString(facts, `variants[${i}].option.color`, child.color);
      pushString(facts, `variants[${i}].option.size`, child.size);
      pushString(facts, `variants[${i}].option.material`, child.material);
      pushString(facts, `variants[${i}].option.pattern`, child.pattern);
      pushStringOrNumber(facts, `variants[${i}].sku`, child.sku);
      const gtin =
        child.gtin13 ?? child.gtin14 ?? child.gtin12 ?? child.gtin8 ?? child.gtin;
      pushStringOrNumber(facts, `variants[${i}].gtin`, gtin);
      pushStringOrNumber(facts, `variants[${i}].barcode`, child.gtin13 ?? child.gtin14);
      const childOffer = pickFirstOffer(child.offers, preferredCurrency);
      if (childOffer) {
        pushNumber(facts, `variants[${i}].price`, childOffer.price);
      }
    });
  } else if (topLevel) {
    // Legacy single-axis size[] (e.g. Decathlon Product block)
    const sizes = pickSizeArray(topLevel.size);
    if (sizes.length > 0) {
      sizes.forEach((s, i) => {
        facts.push(makeFact(`variants[${i}].option.size`, s, s));
      });
    }
  }

  const productName =
    typeof topLevel?.name === "string" ? (topLevel.name as string) : null;
  const breadcrumb = pickBreadcrumb(blocks, productName);
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

function pickProductGroup(
  blocks: Record<string, unknown>[]
): Record<string, unknown> | null {
  return blocks.find((b) => b["@type"] === "ProductGroup") ?? null;
}

function pickHasVariantChildren(
  productGroup: Record<string, unknown>
): Record<string, unknown>[] {
  const raw = productGroup.hasVariant;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord);
}

// gtin13 (EAN-13) wins for retail products — it's what marketplaces require.
// gtin14 is a case-pack identifier and shows up on B2B distributor pages but
// is rarely what we want to match on.
const GTIN_SUBTYPE_ORDER: Array<{ key: string; subtype: string }> = [
  { key: "gtin13", subtype: "gtin13" },
  { key: "gtin12", subtype: "gtin12" },
  { key: "gtin14", subtype: "gtin14" },
  { key: "gtin8", subtype: "gtin8" },
  { key: "gtin", subtype: "gtin" },
];

function pickGtin(
  product: Record<string, unknown>
): { value: string; subtype: string } | null {
  for (const { key, subtype } of GTIN_SUBTYPE_ORDER) {
    const raw = product[key];
    if (typeof raw === "string" && raw.trim()) return { value: raw.trim(), subtype };
    if (typeof raw === "number") return { value: String(raw), subtype };
  }
  return null;
}

function slugifyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const TLD_CURRENCY: Record<string, string> = {
  au: "AUD",
  in: "INR",
  nz: "NZD",
  uk: "GBP",
  gb: "GBP",
  ca: "CAD",
  jp: "JPY",
  sg: "SGD",
  my: "MYR",
  ae: "AED",
  za: "ZAR",
  eu: "EUR",
  de: "EUR",
  fr: "EUR",
  it: "EUR",
  es: "EUR",
  nl: "EUR",
  ie: "EUR",
};

function currencyFromUrl(pageUrl: string): string | null {
  let host: string;
  try {
    host = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  // ".com.au" → take the last label ("au"); ".au" → take "au".
  const parts = host.split(".");
  const tld = parts[parts.length - 1];
  return tld ? (TLD_CURRENCY[tld] ?? null) : null;
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

function pickBreadcrumb(
  blocks: Record<string, unknown>[],
  productName: string | null
): string | null {
  const b = blocks.find((x) => x["@type"] === "BreadcrumbList");
  if (!b) return null;
  const items = b.itemListElement as Record<string, unknown>[] | undefined;
  if (!Array.isArray(items)) return null;
  const names = items
    .map((i) => (typeof i.name === "string" ? i.name : null))
    .filter((n): n is string => n != null);
  if (names.length === 0) return null;

  // The leaf is often the product itself rather than a category. Drop it iff
  // it looks product-specific — defined as: the product name contains it AND
  // the leaf has 3+ tokens. Short leafs like "Running Shoes" or "Phones" are
  // categories on most sites and must stay.
  const leaf = names[names.length - 1] ?? "";
  const path =
    names.length > 1 && looksLikeProductLeaf(leaf, productName)
      ? names.slice(0, -1)
      : names;
  return path.join("/");
}

function looksLikeProductLeaf(leaf: string, productName: string | null): boolean {
  if (!productName) return false;
  const leafNorm = leaf.trim().toLowerCase();
  const nameNorm = productName.trim().toLowerCase();
  if (!leafNorm) return false;
  if (leafNorm === nameNorm) return true;
  const tokens = leafNorm.split(/\s+/).filter(Boolean);
  return tokens.length >= 3 && nameNorm.includes(leafNorm);
}

function pickFirstOffer(
  offers: unknown,
  preferredCurrency: string | null = null
): Record<string, unknown> | null {
  const candidates: Record<string, unknown>[] = [];
  if (Array.isArray(offers)) {
    for (const o of offers) if (isRecord(o)) candidates.push(o);
  } else if (isRecord(offers)) {
    if (offers["@type"] === "AggregateOffer" && Array.isArray(offers.offers)) {
      for (const o of offers.offers) if (isRecord(o)) candidates.push(o);
    } else {
      candidates.push(offers);
    }
  }
  if (candidates.length === 0) return null;
  if (preferredCurrency) {
    const match = candidates.find(
      (o) =>
        typeof o.priceCurrency === "string" &&
        o.priceCurrency.toUpperCase() === preferredCurrency
    );
    if (match) return match;
  }
  return candidates[0] ?? null;
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
    sourceAlternatives: null,
    approved: false,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
