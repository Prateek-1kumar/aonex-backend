// Focused builders for one CSV product group — the decomposition of the old
// ~350-line adaptGroup. Each builder owns one concern (parent observations,
// pricing, variants, images, custom attributes) and is unit-testable in
// isolation; csv/index.ts composes them into an AdapterOutput.

import type { ArtifactId } from "@aonex/types";
import { gtinIssue } from "./gtin.js";
import { parseDecimal } from "./number-parse.js";
import type {
  CanonicalObservation,
  InventoryObservation,
  PricingObservation,
} from "../types.js";

// ── Shared row/group plumbing ────────────────────────────────────────────────

export type CsvRow = Record<string, string>;

export interface IndexedRow {
  row: CsvRow;
  /** 1-based data row index (header excluded). */
  index: number;
}

export interface CsvRowIssue {
  /** 1-based data row index (header excluded). 0 means "file-level / header". */
  row: number;
  code: string;
  message: string;
  primaryIdentifier?: string;
}

/** Per-file context threaded through every builder. */
export interface GroupShared {
  channelCode: string;
  locale: string;
  source: string;
  observedAt: Date;
  artifactId?: ArtifactId;
  channelDefaultCurrency: string | null;
  warnings: CsvRowIssue[];
}

/** Default confidence stamp on every CSV-sourced observation. */
export const DEFAULT_CONFIDENCE = 0.85;
/** Identity (gtin/mpn/brand) signals are high-confidence by convention. */
export const IDENTITY_CONFIDENCE = 0.9;

/** Variant columns — presence of any non-empty value flips a row into "variant" mode. */
export const VARIANT_VALUE_COLUMNS = [
  "variant_color",
  "variant_size",
  "variant_gtin",
  "variant_sku",
  "variant_inventory_qty",
] as const;

/**
 * Treat empty strings as missing. csv-parse with `trim: true` strips surrounding
 * whitespace but keeps `""` as a value (versus undefined). Centralising the
 * "is this column populated?" check avoids subtle bugs where a column with the
 * value `""` is mistaken for a real value.
 */
export function nonEmpty(row: CsvRow, col: string): string | undefined {
  const v = row[col];
  if (v === undefined) return undefined;
  if (v === "") return undefined;
  return v;
}

export function hasAnyVariantField(row: CsvRow): boolean {
  return VARIANT_VALUE_COLUMNS.some((col) => nonEmpty(row, col) !== undefined);
}

/**
 * First non-empty value for a parent-level column ACROSS the whole group, not
 * just row 0. Sellers commonly put the product title/brand/description on a
 * single "lead" row that isn't necessarily the first, or spread parent fields
 * across variant rows. Reading row[0] only silently dropped that data.
 */
export function firstNonEmptyInGroup(
  rows: IndexedRow[],
  col: string
): { value: string; index: number } | undefined {
  for (const { row, index } of rows) {
    const v = nonEmpty(row, col);
    if (v !== undefined) return { value: v, index };
  }
  return undefined;
}

export function parseNumber(raw: string, col: string, rowIndex: number): number {
  const parsed = parseDecimal(raw);
  if (parsed === null) {
    throw new Error(`csvAdapter: row ${rowIndex}: ${col} is not a number (got "${raw}")`);
  }
  return parsed.value;
}

/** Warn (don't drop) on a GTIN that fails GS1 format or check-digit validation. */
export function warnIfBadGtin(
  value: string,
  rowIndex: number,
  label: string,
  primaryIdentifier: string,
  warnings: CsvRowIssue[]
): void {
  const issue = gtinIssue(value);
  if (!issue) return;
  const reason =
    issue === "checksum"
      ? "is invalid (failed GS1 check digit)"
      : "is invalid (must be 8, 12, 13, or 14 digits)";
  warnings.push({
    row: rowIndex,
    code: "INVALID_GTIN",
    message: `row ${rowIndex}: ${label} GTIN "${value}" ${reason}`,
    primaryIdentifier,
  });
}

// ── Parent observations ──────────────────────────────────────────────────────

/** The parent-level identity/text fields adaptGroup consolidates per group. */
export interface ParentFields {
  title?: string;
  brand?: string;
  mpn?: string;
  gtin?: string;
}

/**
 * Declarative registry for scalar parent columns: adding a parent-level CSV
 * column means adding a row here, not editing builder code. `scoped: true`
 * emits under the file's channel/locale; identity-class fields are
 * channel-independent (`_unscoped`).
 */
const PARENT_COLUMN_SPECS: {
  col: string;
  attributeCode: string;
  scoped: boolean;
  confidence: number;
  validateGtin?: boolean;
}[] = [
  { col: "title", attributeCode: "title", scoped: true, confidence: DEFAULT_CONFIDENCE },
  { col: "brand", attributeCode: "brand", scoped: false, confidence: IDENTITY_CONFIDENCE },
  { col: "mpn", attributeCode: "identity.mpn", scoped: false, confidence: IDENTITY_CONFIDENCE },
  { col: "gtin", attributeCode: "identity.gtin", scoped: false, confidence: IDENTITY_CONFIDENCE, validateGtin: true },
  { col: "category", attributeCode: "category_path", scoped: true, confidence: DEFAULT_CONFIDENCE },
  { col: "description_long", attributeCode: "description_long", scoped: true, confidence: DEFAULT_CONFIDENCE },
];

/**
 * Consolidated parent-level observations for the group (title, brand,
 * identifiers, category, description, weight). Throws when the product has
 * neither title nor brand — such a product is unusable downstream.
 */
export function buildParentObservations(
  primaryIdentifier: string,
  groupRows: IndexedRow[],
  shared: GroupShared
): { observations: CanonicalObservation[]; fields: ParentFields } {
  const { channelCode, locale, source, observedAt } = shared;
  const firstIndex = groupRows[0]!.index;
  const observations: CanonicalObservation[] = [];
  const fields: ParentFields = {};

  const hits = new Map(
    PARENT_COLUMN_SPECS.map((spec) => [spec.col, firstNonEmptyInGroup(groupRows, spec.col)])
  );

  // Title-or-brand presence rule — a product with neither is unusable.
  if (hits.get("title") === undefined && hits.get("brand") === undefined) {
    throw new Error(
      `csvAdapter: row ${firstIndex}: product "${primaryIdentifier}" has neither title nor brand`
    );
  }

  for (const spec of PARENT_COLUMN_SPECS) {
    const hit = hits.get(spec.col);
    if (hit === undefined) continue;
    if (spec.validateGtin) {
      warnIfBadGtin(hit.value, hit.index, "parent", primaryIdentifier, shared.warnings);
    }
    if (spec.col === "title") fields.title = hit.value;
    if (spec.col === "brand") fields.brand = hit.value;
    if (spec.col === "mpn") fields.mpn = hit.value;
    if (spec.col === "gtin") fields.gtin = hit.value;
    observations.push({
      attributeCode: spec.attributeCode,
      target: "parent",
      channelCode: spec.scoped ? channelCode : "_unscoped",
      localeCode: spec.scoped ? locale : "_unscoped",
      source,
      sourceRecordId: primaryIdentifier,
      value: hit.value,
      confidence: spec.confidence,
      observedAt,
    });
  }

  // weight: emitted as a single observation with unit preserved in extras
  const weightHit = firstNonEmptyInGroup(groupRows, "weight_value");
  const weightUnitVal = firstNonEmptyInGroup(groupRows, "weight_unit")?.value;
  if (weightHit !== undefined) {
    const weight = parseNumber(weightHit.value, "weight_value", weightHit.index);
    observations.push({
      attributeCode: "weight",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: primaryIdentifier,
      value: weight,
      confidence: DEFAULT_CONFIDENCE,
      observedAt,
      ...(weightUnitVal !== undefined ? { extras: { unit: weightUnitVal } } : {}),
    });
  }

  return { observations, fields };
}

// ── Parent pricing ───────────────────────────────────────────────────────────

export interface ParentPricing {
  pricing: PricingObservation[];
  /** Consolidated parent tiers/currency — inherited by variants without their own. */
  tiers: PricingObservation["tiers"];
  currency: string | null;
}

/** Consolidated parent price tiers (list/sale) across the group. Throws when a
 *  price exists but no currency can be resolved. */
export function buildParentPricing(
  primaryIdentifier: string,
  groupRows: IndexedRow[],
  shared: GroupShared
): ParentPricing {
  const firstIndex = groupRows[0]!.index;
  const listHit = firstNonEmptyInGroup(groupRows, "list_price");
  const saleHit = firstNonEmptyInGroup(groupRows, "sale_price");
  const currency = firstNonEmptyInGroup(groupRows, "currency")?.value ?? shared.channelDefaultCurrency;

  const tiers: PricingObservation["tiers"] = [];
  if (listHit !== undefined) {
    tiers.push({ kind: "list", amount: parseNumber(listHit.value, "list_price", listHit.index) });
  }
  if (saleHit !== undefined) {
    tiers.push({ kind: "sale", amount: parseNumber(saleHit.value, "sale_price", saleHit.index) });
  }

  const pricing: PricingObservation[] = [];
  if (tiers.length > 0) {
    if (currency === null || currency === undefined) {
      throw new Error(
        `csvAdapter: row ${firstIndex}: pricing currency missing (column blank and ctx.channelDefaultCurrency is null)`
      );
    }
    pricing.push({
      productHint: primaryIdentifier,
      channelCode: shared.channelCode,
      locale: shared.locale,
      source: shared.source,
      sourceRecordId: primaryIdentifier,
      currency,
      tiers,
      observedAt: shared.observedAt,
      ...(shared.artifactId !== undefined ? { artifactId: shared.artifactId } : {}),
    });
  }
  return { pricing, tiers, currency };
}

// ── Variants ─────────────────────────────────────────────────────────────────

export interface VariantOutputs {
  observations: CanonicalObservation[];
  pricing: PricingObservation[];
  inventory: InventoryObservation[];
}

/** Per-row variant observations (sku/gtin), pricing (own columns override the
 *  parent's tiers/currency, else inherit) and inventory. */
export function buildVariants(
  primaryIdentifier: string,
  groupRows: IndexedRow[],
  parent: ParentPricing,
  shared: GroupShared
): VariantOutputs {
  const { channelCode, locale, source, observedAt } = shared;
  const observations: CanonicalObservation[] = [];
  const pricing: PricingObservation[] = [];
  const inventory: InventoryObservation[] = [];

  for (const { row, index } of groupRows) {
    if (!hasAnyVariantField(row)) continue;

    const colorVal = nonEmpty(row, "variant_color");
    const sizeVal = nonEmpty(row, "variant_size");
    const variantAxes: Record<string, string> = {};
    if (colorVal !== undefined) variantAxes.color = colorVal;
    if (sizeVal !== undefined) variantAxes.size = sizeVal;

    const variantSkuVal = nonEmpty(row, "variant_sku");
    const variantGtinVal = nonEmpty(row, "variant_gtin");
    const variantInvRaw = nonEmpty(row, "variant_inventory_qty");

    const variantRecordId = variantSkuVal ?? variantGtinVal ?? primaryIdentifier;

    // identity.sku (channel-scoped)
    if (variantSkuVal !== undefined) {
      observations.push({
        attributeCode: "identity.sku",
        target: "variant",
        variantAxes,
        channelCode,
        localeCode: locale,
        source,
        sourceRecordId: variantRecordId,
        value: variantSkuVal,
        confidence: DEFAULT_CONFIDENCE,
        observedAt,
      });
    }

    // identity.gtin (global / _unscoped)
    if (variantGtinVal !== undefined) {
      warnIfBadGtin(variantGtinVal, index, "variant", primaryIdentifier, shared.warnings);
      observations.push({
        attributeCode: "identity.gtin",
        target: "variant",
        variantAxes,
        channelCode: "_unscoped",
        localeCode: "_unscoped",
        source,
        sourceRecordId: variantRecordId,
        value: variantGtinVal,
        confidence: IDENTITY_CONFIDENCE,
        observedAt,
      });
    }

    // Pricing — a variant's OWN price columns override the parent's tiers/currency;
    // otherwise it inherits the parent price (the common single-price-per-product case).
    const vListRaw = nonEmpty(row, "variant_list_price");
    const vSaleRaw = nonEmpty(row, "variant_sale_price");
    const ownTiers: PricingObservation["tiers"] = [];
    if (vListRaw !== undefined) ownTiers.push({ kind: "list", amount: parseNumber(vListRaw, "variant_list_price", index) });
    if (vSaleRaw !== undefined) ownTiers.push({ kind: "sale", amount: parseNumber(vSaleRaw, "variant_sale_price", index) });
    const variantTiers = ownTiers.length > 0 ? ownTiers : parent.tiers;
    const variantCurrency = nonEmpty(row, "variant_currency") ?? parent.currency;

    if (variantTiers.length > 0) {
      if (variantCurrency === null || variantCurrency === undefined) {
        throw new Error(
          `csvAdapter: row ${index}: variant pricing currency missing (column blank and ctx.channelDefaultCurrency is null)`
        );
      }
      pricing.push({
        productHint: primaryIdentifier,
        variantAxes,
        channelCode,
        locale,
        source,
        sourceRecordId: variantRecordId,
        currency: variantCurrency,
        tiers: variantTiers,
        observedAt,
        ...(shared.artifactId !== undefined ? { artifactId: shared.artifactId } : {}),
      });
    }

    // Inventory
    if (variantInvRaw !== undefined) {
      const qty = parseNumber(variantInvRaw, "variant_inventory_qty", index);
      inventory.push({
        productHint: primaryIdentifier,
        variantAxes,
        channelCode,
        qty,
        source,
        sourceRecordId: variantRecordId,
        observedAt,
        ...(shared.artifactId !== undefined ? { artifactId: shared.artifactId } : {}),
      });
    }
  }

  return { observations, pricing, inventory };
}

// ── Images ───────────────────────────────────────────────────────────────────

const IMAGE_COLUMNS = [
  "picture",
  "image_url",
  "image_urls",
  "variant_image_url",
  "variant_image",
  "variant_images",
] as const;

/** One deduped parent `images` observation across all rows. Variant rows
 *  contribute their axes as alt text; an entry with alt text wins over the
 *  same URL without one. Invalid URLs are warned about but still passed
 *  through (downstream decides). */
export function buildImages(
  primaryIdentifier: string,
  groupRows: IndexedRow[],
  shared: GroupShared
): CanonicalObservation[] {
  interface ExtractedImage {
    url: string;
    altText?: string | undefined;
  }

  const extracted: ExtractedImage[] = [];
  for (const { row, index } of groupRows) {
    const colorVal = nonEmpty(row, "variant_color");
    const sizeVal = nonEmpty(row, "variant_size");
    const axesParts: string[] = [];
    if (colorVal !== undefined) axesParts.push(`Color: ${colorVal}`);
    if (sizeVal !== undefined) axesParts.push(`Size: ${sizeVal}`);
    const altText = axesParts.length > 0 ? axesParts.join(", ") : undefined;

    for (const col of IMAGE_COLUMNS) {
      const val = nonEmpty(row, col);
      if (val === undefined) continue;
      const parts = val.startsWith("data:") ? [val] : val.split(",").map((p) => p.trim()).filter(Boolean);
      for (const part of parts) {
        const isValidUrl =
          part.startsWith("http://") || part.startsWith("https://") || part.startsWith("data:image/");
        if (!isValidUrl) {
          shared.warnings.push({
            row: index,
            code: "INVALID_IMAGE_URL",
            message: `row ${index}: Image URL "${part.slice(0, 60)}" must start with http://, https://, or data:image/`,
            primaryIdentifier,
          });
        }
        extracted.push({ url: part, altText });
      }
    }
  }

  const dedupedMap = new Map<string, ExtractedImage>();
  for (const img of extracted) {
    const existing = dedupedMap.get(img.url);
    if (!existing || (!existing.altText && img.altText)) {
      dedupedMap.set(img.url, img);
    }
  }
  const finalImages = Array.from(dedupedMap.values()).map((img) => ({
    url: img.url,
    ...(img.altText ? { altText: img.altText } : {}),
  }));

  if (finalImages.length === 0) return [];
  return [
    {
      attributeCode: "images",
      target: "parent",
      channelCode: shared.channelCode,
      localeCode: shared.locale,
      source: shared.source,
      sourceRecordId: primaryIdentifier,
      value: finalImages,
      confidence: DEFAULT_CONFIDENCE,
      observedAt: shared.observedAt,
    },
  ];
}

// ── Custom attributes ────────────────────────────────────────────────────────

/** Each unrecognized column becomes a custom.<column> parent observation,
 *  consolidated the same way as known parent fields (first non-empty in group). */
export function buildCustomAttrs(
  primaryIdentifier: string,
  groupRows: IndexedRow[],
  customColumns: string[],
  shared: GroupShared
): CanonicalObservation[] {
  const observations: CanonicalObservation[] = [];
  for (const col of customColumns) {
    const customVal = firstNonEmptyInGroup(groupRows, col)?.value;
    if (customVal !== undefined) {
      observations.push({
        attributeCode: `custom.${col}`,
        target: "parent",
        channelCode: shared.channelCode,
        localeCode: shared.locale,
        source: shared.source,
        sourceRecordId: primaryIdentifier,
        value: customVal,
        confidence: DEFAULT_CONFIDENCE,
        observedAt: shared.observedAt,
      });
    }
  }
  return observations;
}
