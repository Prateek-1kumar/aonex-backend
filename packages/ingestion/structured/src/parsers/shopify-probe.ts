import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import type { ParserOutput } from "../types.js";

const BASELINE_CONFIDENCE = 0.95;

export async function parseShopifyProbe(
  pageUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<ParserOutput> {
  const candidates = candidateProbeUrls(pageUrl);
  for (const url of candidates) {
    const facts = await tryProbe(url, fetchFn);
    if (facts.length > 0) {
      return { kind: "shopify_probe", facts, baselineConfidence: BASELINE_CONFIDENCE };
    }
  }
  return { kind: "shopify_probe", facts: [], baselineConfidence: BASELINE_CONFIDENCE };
}

function candidateProbeUrls(pageUrl: string): string[] {
  try {
    const u = new URL(pageUrl);
    const m = u.pathname.match(/\/products\/([^/]+)\b/);
    if (!m) return [];
    return [
      `${u.origin}/products/${m[1]}.json`,
      `${u.origin}/products/${m[1]}.js`,
    ];
  } catch {
    return [];
  }
}

async function tryProbe(
  url: string,
  fetchFn: typeof fetch
): Promise<ExtractedFact[]> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: "application/json" } });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    return [];
  }
  const product =
    (json.product as Record<string, unknown>) ?? (json as Record<string, unknown>);
  if (!product || typeof product !== "object") return [];

  const facts: ExtractedFact[] = [];
  const push = (rawKey: string, v: unknown) =>
    v != null && facts.push(mk(rawKey, v));
  push("title", product.title);
  push("vendor", product.vendor);
  push("description", product.body_html);
  push("productType", product.product_type);

  const variants = Array.isArray(product.variants) ? product.variants : [];
  (variants as Record<string, unknown>[]).forEach((v, i) => {
    push(`variants[${i}].sku`, v.sku);
    push(`variants[${i}].barcode`, v.barcode);
    push(`variants[${i}].price`, v.price);
    push(`variants[${i}].inventory_quantity`, v.inventory_quantity);
    const opt = (v.option1 ?? v.title) as unknown;
    if (typeof opt === "string")
      push(`variants[${i}].option.option1`, opt);
  });
  return facts;
}

function mk(rawKey: string, v: unknown): ExtractedFact {
  return {
    rawKey,
    canonicalPath: null,
    extractedValue: v,
    normalizedValue: v,
    unit: null,
    sourcePointer: `shopify_probe:${rawKey}`,
    extractionMethod: "direct",
    confidence: BASELINE_CONFIDENCE,
    mappingMethod: null,
    mappingCandidates: null,
    sourceAlternatives: null,
    approved: false,
  };
}
