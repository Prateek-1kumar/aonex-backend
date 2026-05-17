import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.95;
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Side-fetch parser for Shopify's public products JSON endpoint.
 *
 * Distinct from shopify-probe.ts which scrapes embedded `theme.product` from
 * rendered HTML. This parser fetches `<store>/products/<handle>.json` directly —
 * Shopify's own API endpoint that returns the product data without rendering.
 */
export async function parseShopifyProductsJson(
  pageUrl: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<ParserOutput> {
  const empty: ParserOutput = {
    kind: "shopify_products_json",
    facts: [],
    baselineConfidence: BASELINE_CONFIDENCE,
  };

  // 1. Parse the URL; if not a /products/<handle> path, return immediately.
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return empty;
  }

  const match = parsed.pathname.match(/^\/products\/([^/]+)\/?$/);
  if (!match) return empty;

  const handle = match[1]!;
  const jsonUrl = `${parsed.origin}/products/${handle}.json`;

  // 2. Fetch with timeout.
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    res = await fetchImpl(jsonUrl, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
  } catch {
    return empty;
  }

  if (!res.ok) return empty;

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return empty;
  }

  if (!isRecord(data)) return empty;

  const product = data["product"];
  if (!isRecord(product)) return empty;

  // 3. Extract facts.
  const facts: ExtractedFact[] = [];

  pushString(facts, "title", product["title"]);
  pushString(facts, "brand", product["vendor"]);
  pushString(facts, "description", product["body_html"]);
  pushString(facts, "category_path", product["product_type"]);

  // 4. Extract price and gtin from variants.
  const variants = Array.isArray(product["variants"])
    ? (product["variants"] as unknown[]).filter(isRecord)
    : [];

  // Try to pick the variant matching the URL's variant query param.
  const variantParam = parsed.searchParams.get("variant");
  let pickedVariant: Record<string, unknown> | null = null;
  if (variantParam && variants.length > 0) {
    pickedVariant =
      variants.find((v) => String(v["id"]) === variantParam) ?? null;
  }
  if (!pickedVariant && variants.length > 0) {
    pickedVariant = variants[0]!;
  }

  if (pickedVariant) {
    pushNumber(facts, "base_price", pickedVariant["price"]);
    pushString(facts, "gtin", pickedVariant["barcode"]);
  }

  return { kind: "shopify_products_json", facts, baselineConfidence: BASELINE_CONFIDENCE };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function makeFact(rawKey: string, extractedValue: unknown): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue,
    normalizedValue: extractedValue,
    unit: null,
    sourcePointer: `shopify_products_json:${rawKey}`,
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
  value: unknown
): void {
  if (typeof value !== "string" || !value.trim()) return;
  facts.push(makeFact(rawKey, value));
}

function pushNumber(
  facts: ExtractedFact[],
  rawKey: string,
  value: unknown
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    facts.push(makeFact(rawKey, value));
    return;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) facts.push(makeFact(rawKey, n));
  }
}
