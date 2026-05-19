import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import { normalizeImageUrls } from "./image-normalizer.js";
import { classifyImageRoles } from "./image-role-classifier.js";
import { linkVariantsToImages } from "./variant-image-linker.js";
import { parseUnit } from "./unit-parser.js";
import { validatePricing, validateGtin, dedupeVariantSkus } from "./sanity-validators.js";
import type { SkuJson, SourceTag } from "./index.js";

const KNOWN_TOP_KEYS = new Set([
  "title", "brand", "gtin", "mpn", "model_number", "sku",
  "description", "description_short", "description_long",
  "highlights", "category_path", "category_confidence", "productType", "breadcrumbs",
  "list_price", "sale_price", "base_price", "currency", "discount_percent", "price_per_unit",
  "rating_average", "rating_count", "seller_name", "seller_is_official",
  "images", "options",
  "shipping_free", "shipping_cost", "weight", "dimensions",
  "warranty", "return_policy"
]);

function methodToSource(m: string | null | undefined): SourceTag {
  if (!m) return "structured";
  if (m === "direct") return "structured";
  if (m === "inferred") return "llm-text";
  if (m === "computed") return "enrichment";
  return (m as SourceTag);
}

export function convertFromFacts(
  facts: ExtractedFact[],
  baseUrl: string,
  opts: { ogImage?: string | null } = {}
): SkuJson {
  // Index facts
  const byKey = new Map<string, ExtractedFact>();
  const variantBuckets = new Map<number, Record<string, unknown>>();
  for (const f of facts) {
    const m = f.rawKey.match(/^variants\[(\d+)\]\.(.+)$/);
    if (m) {
      const idx = Number(m[1]);
      const subKey = m[2]!;
      if (!variantBuckets.has(idx)) variantBuckets.set(idx, {});
      variantBuckets.get(idx)![subKey] = f.normalizedValue ?? f.extractedValue;
      continue;
    }
    byKey.set(f.rawKey, f);
  }

  const get = <T>(key: string, fallback: T): T =>
    (byKey.get(key)?.normalizedValue ?? byKey.get(key)?.extractedValue ?? fallback) as T;

  // Pricing
  const pricingRaw = {
    list_price: get<number | null>("list_price", get<number | null>("base_price", null)),
    sale_price: get<number | null>("sale_price", null),
    currency: get<string | null>("currency", null)
  };
  const pricingV = validatePricing(pricingRaw);

  // Images
  const rawImages = get<Array<{ url: string; alt?: string | null; srcset?: string | null; altText?: string | null }>>("images", []);
  // Tolerate both shapes: { url, altText } (legacy) and { url, alt } (new)
  const normalized = normalizeImageUrls(
    rawImages.map((i) => ({ url: i.url, alt: i.alt ?? i.altText ?? null, srcset: i.srcset ?? null })),
    baseUrl
  );
  const roled = classifyImageRoles(normalized, opts.ogImage ?? null);
  const skuImages = roled.map((r) => ({
    url: r.url,
    role: r.role,
    position: r.position,
    alt_text: r.alt,
    width: null as number | null,
    height: null as number | null,
    variant_refs: [] as string[]
  }));

  // Variants
  const rawVariants = Array.from(variantBuckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v);

  const variantsForLinking = rawVariants.map((v) => {
    const optionValues: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k.startsWith("option.")) optionValues[k.slice("option.".length)] = String(val);
    }
    // Also support v.option_values when present
    if (v["option_values"] && typeof v["option_values"] === "object") {
      Object.assign(optionValues, v["option_values"] as Record<string, string>);
    }
    return {
      sku: (v["sku"] as string) ?? null,
      option_values: optionValues
    };
  });
  const linked = linkVariantsToImages(variantsForLinking, normalized);

  const skuVariants = rawVariants.map((v, i) => ({
    sku: (v["sku"] as string) ?? null,
    barcode: (v["barcode"] as string) ?? null,
    option_values: variantsForLinking[i]?.option_values ?? {},
    pricing: {
      list_price: (v["list_price"] as number) ?? (v["price"] as number) ?? null,
      sale_price: (v["sale_price"] as number) ?? null,
      currency: pricingRaw.currency
    },
    image_urls: linked[i]?.image_urls ?? []
  }));
  const dedupedV = dedupeVariantSkus(skuVariants);

  // Attributes — non-top-level keys
  const attributes: SkuJson["attributes"] = {};
  for (const [k, f] of byKey.entries()) {
    if (KNOWN_TOP_KEYS.has(k)) continue;
    const v = f.normalizedValue ?? f.extractedValue;
    const parsed = typeof v === "string" ? parseUnit(v) : null;
    attributes[k] = {
      value: parsed?.value ?? v,
      unit: parsed?.unit ?? f.unit ?? null,
      source: methodToSource(f.extractionMethod)
    };
  }

  // Provenance maps
  const _field_source: Record<string, SourceTag> = {};
  const _field_confidence: Record<string, number> = {};
  for (const [k, f] of byKey.entries()) {
    _field_source[k] = methodToSource(f.extractionMethod);
    _field_confidence[k] = f.confidence ?? 0;
  }

  // GTIN validation
  const gtinV = validateGtin(get<string | null>("gtin", null));

  return {
    title: get("title", null),
    brand: get("brand", null),
    gtin: gtinV.value,
    mpn: get("mpn", null),
    model_number: get("model_number", null),
    sku: get("sku", null),
    description_short: get("description_short", null),
    description_long: get("description_long", get("description", null)),
    highlights: get("highlights", []),
    category_path: get("category_path", get("productType", null)),
    category_confidence: get("category_confidence", 0),
    breadcrumbs: get("breadcrumbs", []),
    pricing: {
      list_price: pricingV.value.list_price,
      sale_price: pricingV.value.sale_price,
      currency: pricingV.value.currency,
      discount_percent: get("discount_percent", null),
      price_per_unit: get("price_per_unit", null)
    },
    ratings: { average: get("rating_average", null), count: get("rating_count", null) },
    seller: { name: get("seller_name", null), is_official: get("seller_is_official", null) },
    images: skuImages,
    options: get("options", []),
    variants: dedupedV.value,
    attributes,
    shipping: {
      free_shipping: get("shipping_free", null),
      shipping_cost: get("shipping_cost", null),
      weight: get("weight", null),
      dimensions: get("dimensions", null)
    },
    warranty: get("warranty", null),
    return_policy: get("return_policy", null),
    _field_confidence,
    _field_source,
    _extraction_meta: {
      passes_run: [],
      tokens_used: 0,
      cost_usd: 0,
      latency_ms: 0,
      escalated_to: "static",
      validation_warnings: [
        ...pricingV.warnings,
        ...gtinV.warnings,
        ...dedupedV.warnings
      ]
    }
  };
}
