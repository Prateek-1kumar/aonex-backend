export interface CanonicalVariantPayload {
  sku: string | null;
  barcode: string | null;
  price: number | null;
  currency: string | null;
  inventoryQuantity: number | null;
  optionValues: Record<string, string>;
}

export interface CanonicalProductPayload {
  title: string | null;
  brand: string | null;
  gtin: string | null;
  gtinType: string | null;
  modelNumber: string | null;
  manufacturerPartNumber: string | null;
  description: string | null;
  basePrice: number | null;
  currency: string | null;
  weightGrams: number | null;
  dimensionsCm: { l?: number; w?: number; h?: number } | null;
  canonicalCategory: string | null;
  /** Pre-mapper hint; final value persisted on product_versions is computed in applyApprovedDiff */
  categorySchemaVersion: string | null;
  categoryConfidence: number | null;
  images: Array<{ url: string; altText?: string }>;
  attributes: Record<string, unknown>;
  variants: CanonicalVariantPayload[];
  evidence: Record<string, unknown>;
}

export function parseCanonicalPayload(raw: Record<string, unknown>): CanonicalProductPayload {
  return {
    title: stringOrNull(raw.title),
    brand: stringOrNull(raw.brand),
    gtin: stringOrNull(raw.gtin),
    gtinType: stringOrNull(raw.gtinType ?? raw.gtin_type),
    modelNumber: stringOrNull(raw.modelNumber ?? raw.model_number),
    manufacturerPartNumber: stringOrNull(
      raw.manufacturerPartNumber ?? raw.manufacturer_part_number
    ),
    description: stringOrNull(raw.description),
    basePrice: numberOrNull(raw.basePrice ?? raw.base_price),
    currency: stringOrNull(raw.currency)?.toUpperCase() ?? null,
    weightGrams: numberOrNull(raw.weightGrams ?? raw.weight_grams),
    dimensionsCm: parseDimensionsCm(raw.dimensionsCm ?? raw.dimensions_cm),
    canonicalCategory: stringOrNull(raw.canonicalCategory ?? raw.canonical_category),
    categorySchemaVersion: stringOrNull(
      raw.categorySchemaVersion ?? raw.category_schema_version
    ),
    categoryConfidence: numberOrNull(raw.categoryConfidence ?? raw.category_confidence),
    images: parseImages(raw.images),
    attributes: isRecord(raw.attributes) ? raw.attributes : {},
    variants: Array.isArray(raw.variants) ? raw.variants.map(parseVariant) : [],
    evidence: isRecord(raw.evidence) ? raw.evidence : {},
  };
}

function parseDimensionsCm(
  raw: unknown
): { l?: number; w?: number; h?: number } | null {
  if (!isRecord(raw)) return null;
  const out: { l?: number; w?: number; h?: number } = {};
  const l = numberOrNull(raw.l);
  const w = numberOrNull(raw.w);
  const h = numberOrNull(raw.h);
  if (l != null) out.l = l;
  if (w != null) out.w = w;
  if (h != null) out.h = h;
  return Object.keys(out).length > 0 ? out : null;
}

function parseVariant(raw: unknown): CanonicalVariantPayload {
  const record = isRecord(raw) ? raw : {};
  return {
    sku: stringOrNull(record.sku),
    barcode: stringOrNull(record.barcode),
    price: numberOrNull(record.price),
    currency: stringOrNull(record.currency)?.toUpperCase() ?? null,
    inventoryQuantity: numberOrNull(record.inventoryQuantity ?? record.inventory_quantity),
    optionValues: parseOptionValues(record.optionValues ?? record.option_values),
  };
}

function parseImages(raw: unknown): Array<{ url: string; altText?: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    const url = stringOrNull(item.url);
    if (!url) return [];
    const image: { url: string; altText?: string } = { url };
    const altText = stringOrNull(item.altText ?? item.alt_text);
    if (altText) image.altText = altText;
    return [image];
  });
}

function parseOptionValues(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = stringOrNull(value);
    if (normalized) out[key] = normalized;
  }
  return out;
}

export function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return value == null ? null : String(value);
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}
