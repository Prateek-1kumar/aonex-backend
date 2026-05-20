import { normalizeAxisName, normalizeAxisValue, checkVariantMatrix } from "@aonex/ingestion-variant-extractor";
import type { RouterInput, PolicyInputs } from "@aonex/ingestion-policy-engine";
import type { CanonicalProductPayload } from "@aonex/catalog-service";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import { domainOf } from "@aonex/lib-utils";
import type { DrizzleClient } from "@aonex/db";
import type { ArtifactId, MerchantId, TenantId } from "@aonex/types";

export const CORE_FIELD_MAP: Record<string, string> = {
  title: "title",
  brand: "brand",
  vendor: "brand",
  gtin: "gtin",
  barcode: "gtin",
  model_number: "modelNumber",
  modelNumber: "modelNumber",
  mpn: "modelNumber",
  description: "description",
  base_price: "basePrice",
  price: "basePrice",
  currency: "currency",
  category_path: "canonicalCategory",
  productType: "canonicalCategory",
  images: "images",
};

export async function buildRouterInput(args: {
  db: DrizzleClient;
  tenantId: TenantId;
  facts: ExtractedFact[];
  payload: CanonicalProductPayload;
  domain: string;
  category: { path: string | null; confidence: number };
  categoryRequiredAttributes: string[];
}): Promise<RouterInput> {
  const identityIndex: RouterInput["identityIndex"] = {};

  // Helper: look up an identity row + its product's latest version
  async function lookupIdentity(
    identityType: "gtin" | "mpn",
    identityValue: string
  ): Promise<RouterInput["identityIndex"]["gtin"] | undefined> {
    const row = await args.db.query.productIdentities.findFirst({
      where: (i, { and, eq }) =>
        and(
          eq(i.tenantId, args.tenantId),
          eq(i.identityType, identityType),
          eq(i.identityValue, identityValue)
        ),
    });
    if (!row) return undefined;
    const pv = await args.db.query.productVersions.findFirst({
      where: (v, { eq }) => eq(v.productId, row.productId),
      orderBy: (v, { desc }) => [desc(v.createdAt)],
    });
    return {
      productId: row.productId,
      brand: pv?.brand ?? null,
      // product_versions uses `canonicalCategory` column
      canonicalCategory: pv?.canonicalCategory ?? null,
    };
  }

  if (args.payload.gtin) {
    const gtinHit = await lookupIdentity("gtin", args.payload.gtin);
    if (gtinHit) identityIndex.gtin = gtinHit;
  }
  // CanonicalProductPayload uses `modelNumber` (mapped from mpn/model_number)
  if (args.payload.modelNumber) {
    const mpnHit = await lookupIdentity("mpn", args.payload.modelNumber);
    if (mpnHit) identityIndex.mpn = mpnHit;
  }

  // priceCluster
  let priceCluster: RouterInput["priceCluster"] = null;
  if (args.payload.brand && args.payload.canonicalCategory && args.payload.currency) {
    const cluster = await args.db.query.priceClusters.findFirst({
      where: (c, { and, eq }) =>
        and(
          eq(c.tenantId, args.tenantId),
          eq(c.brand, args.payload.brand!),
          eq(c.canonicalCategory, args.payload.canonicalCategory!),
          eq(c.currency, args.payload.currency!)
        ),
    });
    if (cluster) {
      priceCluster = {
        medianPrice: Number(cluster.medianPrice),
        sampleCount: cluster.sampleCount,
      };
    }
  }

  // Normalize axis names + values so detectors see consistent shape.
  const normalizedVariants: Array<{ optionValues: Record<string, string> }> = [];
  const variantAxes: Record<string, string[]> = {};
  for (const v of args.payload.variants) {
    const normalizedOV: Record<string, string> = {};
    for (const [axis, value] of Object.entries(v.optionValues ?? {})) {
      if (typeof value !== "string") continue;
      const normAxis = normalizeAxisName(axis);
      const normValue = normalizeAxisValue(normAxis, value);
      if (!normValue) continue;
      normalizedOV[normAxis] = normValue;
      const set = (variantAxes[normAxis] ??= []);
      if (!set.includes(normValue)) set.push(normValue);
    }
    normalizedVariants.push({ optionValues: normalizedOV });
  }

  // Sanity check the matrix (exposed via console / future telemetry, not currently in RouterInput).
  const matrix = checkVariantMatrix({ variants: normalizedVariants, axes: variantAxes });
  if (!matrix.complete && matrix.expected > 0) {
    // The variant_incomplete detector independently catches this with the same logic.
    // Logging here helps with operational visibility.
    console.debug(
      `[router-input] variant matrix incomplete: ${matrix.actual}/${matrix.expected}`,
      { domain: args.domain, axes: variantAxes }
    );
  }

  return {
    facts: args.facts,
    payload: {
      title: args.payload.title,
      brand: args.payload.brand,
      gtin: args.payload.gtin,
      // CanonicalProductPayload uses `modelNumber` (not `mpn`)
      modelNumber: args.payload.modelNumber,
      // CanonicalProductPayload uses `basePrice` (not `price`)
      basePrice: args.payload.basePrice,
      currency: args.payload.currency,
      canonicalCategory: args.payload.canonicalCategory,
      // variants have `optionValues` (Record<string,string>), `sku`, `price`
      variants: args.payload.variants.map((v) => ({
        optionValues: v.optionValues ?? {},
        sku: v.sku ?? null,
        price: v.price ?? null,
      })),
    },
    domain: args.domain,
    category: args.category,
    categoryRequiredAttributes: args.categoryRequiredAttributes,
    identityIndex,
    priceCluster,
    variantAxes,
  };
}

export function withFallbackCanonicalPath(fact: ExtractedFact): ExtractedFact {
  const fallback = CORE_FIELD_MAP[fact.rawKey];
  if (!fallback || fact.canonicalPath) return fact;
  return {
    ...fact,
    canonicalPath: fallback,
    mappingMethod: fact.mappingMethod ?? "link_core_field",
    mappingCandidates: fact.mappingCandidates ?? [{ key: fallback, score: 0.95 }],
    approved: fact.confidence >= 0.85,
  };
}

export function buildCanonicalPayload(input: {
  facts: ExtractedFact[];
  sourceUrl: string;
  artifactId: ArtifactId;
  suggestedCategory: string | null;
  categoryConfidence: number;
  mapperVersion: string;
  extractorVersion: string;
  extractorMeta: {
    modelName: string | null;
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
  };
}): CanonicalProductPayload {
  const best = new Map<string, ExtractedFact>();
  for (const fact of input.facts) {
    const key = fact.canonicalPath ?? fact.rawKey;
    const previous = best.get(key);
    if (!previous || fact.confidence > previous.confidence) best.set(key, fact);
  }

  const attributes: Record<string, unknown> = {};
  for (const fact of input.facts) {
    const key = fact.canonicalPath ?? fact.rawKey;
    if (Object.values(CORE_FIELD_MAP).includes(key)) continue;
    if (key.startsWith("variants[")) continue;
    attributes[key] = fact.normalizedValue ?? fact.extractedValue;
  }

  return {
    title: stringValue(best.get("title")),
    brand: stringValue(best.get("brand")),
    gtin: stringValue(best.get("gtin")),
    gtinType: null,
    modelNumber: stringValue(best.get("modelNumber")),
    manufacturerPartNumber: null,
    description: stringValue(best.get("description")),
    basePrice: numberValue(best.get("basePrice")),
    currency: stringValue(best.get("currency"))?.toUpperCase() ?? null,
    weightGrams: null,
    dimensionsCm: null,
    canonicalCategory:
      stringValue(best.get("canonicalCategory")) ?? input.suggestedCategory,
    categorySchemaVersion: null,
    categoryConfidence: input.categoryConfidence,
    images: imageValue(best.get("images"), input.facts),
    attributes,
    variants: variantValue(input.facts, stringValue(best.get("currency"))),
    evidence: {
      sourceUrl: input.sourceUrl,
      artifactId: input.artifactId,
      categoryConfidence: input.categoryConfidence,
      extractorVersion: input.extractorVersion,
      mapperVersion: input.mapperVersion,
      modelName: input.extractorMeta.modelName,
      promptTokens: input.extractorMeta.promptTokens,
      completionTokens: input.extractorMeta.completionTokens,
      estimatedCostUsd: input.extractorMeta.estimatedCostUsd,
    },
  };
}

export function stringValue(fact: ExtractedFact | undefined): string | null {
  const value = fact?.normalizedValue ?? fact?.extractedValue;
  if (value == null) return null;
  const str = String(value).trim();
  return str ? str : null;
}

export function numberValue(fact: ExtractedFact | undefined): number | null {
  const value = fact?.normalizedValue ?? fact?.extractedValue;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function imageValue(
  fact: ExtractedFact | undefined,
  allFacts: ExtractedFact[]
): Array<{ url: string; altText?: string }> {
  // Primary path: LLM extracts a single `images` fact whose value is an array.
  // Accept both legacy `{url, altText}` and new SkuImage-ish `{url, alt}` shapes.
  const value = fact?.normalizedValue ?? fact?.extractedValue;
  if (Array.isArray(value)) {
    const fromArray = value.flatMap((item) => {
      if (!isRecord(item) || typeof item.url !== "string") return [];
      const image: { url: string; altText?: string } = { url: item.url };
      const alt = item.altText ?? item.alt ?? item.alt_text;
      if (typeof alt === "string" && alt.trim()) image.altText = alt;
      return [image];
    });
    if (fromArray.length > 0) return dedupeImages(fromArray);
  }

  // Fallback: DOM heuristics emit one fact per image as rawKey="image_url"
  // with `extractedValue` = the URL string. Without this fallback, every
  // DOM-scraped image is dropped on the floor when the LLM doesn't echo
  // images back in its JSON.
  const fromDom = allFacts
    .filter((f) => f.rawKey === "image_url")
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .flatMap((f) => {
      const url = typeof f.normalizedValue === "string"
        ? f.normalizedValue
        : (typeof f.extractedValue === "string" ? f.extractedValue : null);
      if (!url || !/^https?:\/\//i.test(url)) return [];
      return [{ url } as { url: string; altText?: string }];
    });
  return dedupeImages(fromDom);
}

export function dedupeImages(
  images: Array<{ url: string; altText?: string }>
): Array<{ url: string; altText?: string }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; altText?: string }> = [];
  for (const img of images) {
    if (seen.has(img.url)) continue;
    seen.add(img.url);
    out.push(img);
  }
  return out;
}

export function variantValue(facts: ExtractedFact[], fallbackCurrency: string | null) {
  const variants = new Map<number, Record<string, unknown>>();
  for (const fact of facts) {
    const match = /^variants\[(\d+)\]\.(.+)$/.exec(fact.rawKey);
    if (!match) continue;
    const [, indexRaw, field] = match;
    if (!indexRaw || !field) continue;
    const index = Number(indexRaw);
    const record = variants.get(index) ?? { optionValues: {} };
    if (field.startsWith("option.")) {
      const optionName = field.replace("option.", "");
      const options = isRecord(record.optionValues) ? record.optionValues : {};
      options[optionName] = String(fact.normalizedValue ?? fact.extractedValue);
      record.optionValues = options;
    } else {
      record[field] = fact.normalizedValue ?? fact.extractedValue;
    }
    variants.set(index, record);
  }

  return Array.from(variants.values()).map((record) => ({
    sku: typeof record.sku === "string" ? record.sku : null,
    barcode: typeof record.barcode === "string" ? record.barcode : null,
    price: typeof record.price === "number" ? record.price : numberFromUnknown(record.price),
    currency: fallbackCurrency,
    inventoryQuantity: numberFromUnknown(record.inventory_quantity),
    optionValues: isRecord(record.optionValues)
      ? Object.fromEntries(
          Object.entries(record.optionValues).map(([key, value]) => [key, String(value)])
        )
      : {},
  }));
}

export function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
