import { parse } from "csv-parse/sync";
import type { ArtifactId } from "@aonex/types";
import type {
  SourceAdapter,
  AdapterOutput,
  AdaptContext,
  CanonicalObservation,
  PricingObservation,
  InventoryObservation,
  IdentityHint,
} from "../types.js";

/**
 * Envelope shape consumed by the csv adapter.
 *
 * Why this is not just a raw string: the adapter needs the filename to build
 * the source tag (`csv:<filename>`), an explicit observedAt so observations
 * carry a deterministic timestamp (NOT Date.now()), and an optional artifactId
 * so pricing/inventory observations can be linked back to the originating
 * upload artifact. Callers (the catalog-service upload handler in Phase 3)
 * wrap the file's text contents in this envelope before invoking the adapter.
 */
export interface CsvAdapterInput {
  csv: string;
  filename: string;
  observedAt: string | Date;
  artifactId?: ArtifactId;
  /** Optional override; defaults to "csv". */
  channelCode?: string;
}

/** All column headers the CSV adapter understands. Used for unknown-header warnings. */
export const KNOWN_CSV_COLUMNS = [
  "primary_identifier",
  "title", "brand", "gtin", "mpn", "category", "description_long",
  "list_price", "sale_price", "currency", "weight_value", "weight_unit",
  "variant_sku", "variant_color", "variant_size", "variant_gtin", "variant_inventory_qty",
  "picture", "image_url", "image_urls", "variant_image_url", "variant_image", "variant_images",
] as const;

/**
 * Alias mapping — maps common non-canonical column names to their canonical
 * equivalents. Applied after basic normalization (lowercase, underscored).
 * This lets users upload CSVs with headers like "SKU", "Product Name",
 * "Description", "Product Type" and have them map correctly.
 */
export const COLUMN_ALIASES: Record<string, string> = {
  // primary identifier aliases
  sku: "primary_identifier",
  product_id: "primary_identifier",
  item_id: "primary_identifier",
  item_number: "primary_identifier",
  article_number: "primary_identifier",
  // title aliases
  product_name: "title",
  name: "title",
  product_title: "title",
  item_name: "title",
  // description aliases
  description: "description_long",
  product_description: "description_long",
  long_description: "description_long",
  // category aliases
  product_type: "category",
  product_category: "category",
  category_path: "category",
  // image aliases
  image: "image_url",
  picture_url: "image_url",
  product_image: "image_url",
  // gtin aliases
  barcode: "gtin",
  ean: "gtin",
  upc: "gtin",
};

/** Set of all alias source names — used to suppress unknown-column warnings for aliased headers. */
const ALIAS_SOURCE_NAMES = new Set(Object.keys(COLUMN_ALIASES));

/**
 * Apply column aliases to a header name. Returns the canonical name if an
 * alias exists, otherwise returns the header unchanged.
 */
function applyAlias(header: string): string {
  return COLUMN_ALIASES[header] ?? header;
}

export interface CsvRowIssue {
  /** 1-based data row index (header excluded). 0 means "file-level / header". */
  row: number;
  code: string;
  message: string;
  primaryIdentifier?: string;
}

export interface CsvGroupResult {
  primaryIdentifier: string;
  /** 1-based data row indices that formed this group. */
  rowIndices: number[];
  output: AdapterOutput;
}

export interface CsvAdaptGroupsResult {
  groups: CsvGroupResult[];
  /** Groups dropped due to a validation error (severity: error). */
  errors: CsvRowIssue[];
  /** Non-fatal issues (severity: warning), e.g. unrecognized columns. */
  warnings: CsvRowIssue[];
  /** Number of data rows parsed (header excluded). */
  rowCount: number;
}

export interface CsvInspectResult {
  headers: string[];
  rowCount: number;
  delimiter: "," | ";";
}

/** Default confidence stamp on every CSV-sourced observation. */
const DEFAULT_CONFIDENCE = 0.85;
/** Identity (gtin/mpn/brand) signals are high-confidence by convention. */
const IDENTITY_CONFIDENCE = 0.9;
/** Default channel code when caller doesn't pass one. */
const DEFAULT_CHANNEL = "csv";

/** Required header columns. */
const REQUIRED_COLUMNS = ["primary_identifier"] as const;

/** Variant columns — presence of any non-empty value flips a row into "variant" mode. */
const VARIANT_VALUE_COLUMNS = [
  "variant_color",
  "variant_size",
  "variant_gtin",
  "variant_sku",
  "variant_inventory_qty",
] as const;

type CsvRow = Record<string, string>;

/**
 * Treat empty strings as missing. csv-parse with `trim: true` strips surrounding
 * whitespace but keeps `""` as a value (versus undefined). Centralising the
 * "is this column populated?" check avoids subtle bugs where a column with the
 * value `""` is mistaken for a real value.
 */
function nonEmpty(row: CsvRow, col: string): string | undefined {
  const v = row[col];
  if (v === undefined) return undefined;
  if (v === "") return undefined;
  return v;
}

function hasAnyVariantField(row: CsvRow): boolean {
  return VARIANT_VALUE_COLUMNS.some((col) => nonEmpty(row, col) !== undefined);
}

/** Strip a UTF-8 BOM if present. Excel/Sheets prepend one and it corrupts the first header. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Sniff the delimiter from the header line: ';' (common in European locales) else ','. */
function detectDelimiter(text: string): "," | ";" {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semis = (firstLine.match(/;/g) ?? []).length;
  return semis > commas ? ";" : ",";
}

/** Strip currency symbols and thousands separators so "$1,299.00" parses as 1299. */
function cleanNumeric(raw: string): string {
  return raw.replace(/[^0-9.-]/g, "");
}

/** Levenshtein distance — bounded use for "did you mean" header suggestions. */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  return d[m]![n]!;
}

/** Nearest known column within edit distance 2, else null. */
function suggestColumn(header: string): string | null {
  let best: string | null = null;
  let bestDist = 3;
  for (const known of KNOWN_CSV_COLUMNS) {
    const dist = editDistance(header.toLowerCase(), known);
    if (dist < bestDist) { bestDist = dist; best = known; }
  }
  return best;
}

function parseNumber(raw: string, col: string, rowIndex: number): number {
  const cleaned = cleanNumeric(raw);
  const n = cleaned === "" ? NaN : Number(cleaned);
  if (!Number.isFinite(n)) {
    throw new Error(
      `csvAdapter: row ${rowIndex}: ${col} is not a number (got "${raw}")`,
    );
  }
  return n;
}

interface IndexedRow { row: CsvRow; index: number; }

interface GroupShared {
  channelCode: string;
  locale: string;
  source: string;
  observedAt: Date;
  artifactId?: ArtifactId;
  channelDefaultCurrency: string | null;
  warnings: CsvRowIssue[];
}

/**
 * Build the AdapterOutput for ONE product group. Throws on a row-level
 * validation error (caught per-group by adaptGroups so one bad group does not
 * abort the file). Identity hint is for THIS group only.
 */
function adaptGroup(
  primaryIdentifier: string,
  groupRows: IndexedRow[],
  shared: GroupShared,
  customColumns: string[] = [],
): AdapterOutput {
  const { channelCode, locale, source, observedAt } = shared;
  const observations: CanonicalObservation[] = [];
  const pricing: PricingObservation[] = [];
  const inventory: InventoryObservation[] = [];

  const first = groupRows[0]!;
  const firstRow = first.row;
  const firstIndex = first.index;
  const productHint = primaryIdentifier;
  const parentRecordId = primaryIdentifier;

  const titleVal = nonEmpty(firstRow, "title");
  const brandVal = nonEmpty(firstRow, "brand");

  // NEW: title-or-brand presence rule — a product with neither is unusable.
  if (titleVal === undefined && brandVal === undefined) {
    throw new Error(
      `csvAdapter: row ${firstIndex}: product "${primaryIdentifier}" has neither title nor brand`,
    );
  }

  // --- Parent observations (first row in group only) ----------------------

  if (titleVal !== undefined) {
    observations.push({
      attributeCode: "title",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: parentRecordId,
      value: titleVal,
      confidence: DEFAULT_CONFIDENCE,
      observedAt,
    });
  }

  if (brandVal !== undefined) {
    observations.push({
      attributeCode: "brand",
      target: "parent",
      channelCode: "_unscoped",
      localeCode: "_unscoped",
      source,
      sourceRecordId: parentRecordId,
      value: brandVal,
      confidence: IDENTITY_CONFIDENCE,
      observedAt,
    });
  }

  const mpnVal = nonEmpty(firstRow, "mpn");
  if (mpnVal !== undefined) {
    observations.push({
      attributeCode: "identity.mpn",
      target: "parent",
      channelCode: "_unscoped",
      localeCode: "_unscoped",
      source,
      sourceRecordId: parentRecordId,
      value: mpnVal,
      confidence: IDENTITY_CONFIDENCE,
      observedAt,
    });
  }

  const gtinVal = nonEmpty(firstRow, "gtin");
  if (gtinVal !== undefined) {
    const isValidGtin = /^\d+$/.test(gtinVal) && [8, 12, 13, 14].includes(gtinVal.length);
    if (!isValidGtin) {
      shared.warnings.push({
        row: firstIndex,
        code: "INVALID_GTIN",
        message: `row ${firstIndex}: parent GTIN "${gtinVal}" is invalid (must be 8, 12, 13, or 14 digits)`,
        primaryIdentifier,
      });
    }
    observations.push({
      attributeCode: "identity.gtin",
      target: "parent",
      channelCode: "_unscoped",
      localeCode: "_unscoped",
      source,
      sourceRecordId: parentRecordId,
      value: gtinVal,
      confidence: IDENTITY_CONFIDENCE,
      observedAt,
    });
  }

  const categoryVal = nonEmpty(firstRow, "category");
  if (categoryVal !== undefined) {
    observations.push({
      attributeCode: "category_path",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: parentRecordId,
      value: categoryVal,
      confidence: DEFAULT_CONFIDENCE,
      observedAt,
    });
  }

  const descLongVal = nonEmpty(firstRow, "description_long");
  if (descLongVal !== undefined) {
    observations.push({
      attributeCode: "description_long",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: parentRecordId,
      value: descLongVal,
      confidence: DEFAULT_CONFIDENCE,
      observedAt,
    });
  }

  // weight: emitted as a single observation with unit preserved in extras
  const weightValRaw = nonEmpty(firstRow, "weight_value");
  const weightUnitVal = nonEmpty(firstRow, "weight_unit");
  if (weightValRaw !== undefined) {
    const weight = parseNumber(weightValRaw, "weight_value", firstIndex);
    observations.push({
      attributeCode: "weight",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: parentRecordId,
      value: weight,
      confidence: DEFAULT_CONFIDENCE,
      observedAt,
      ...(weightUnitVal !== undefined
        ? { extras: { unit: weightUnitVal } }
        : {}),
    });
  }

  // --- Parent pricing (first row in group) -------------------------------

  const listPriceRaw = nonEmpty(firstRow, "list_price");
  const salePriceRaw = nonEmpty(firstRow, "sale_price");
  const parentCurrency = nonEmpty(firstRow, "currency") ?? shared.channelDefaultCurrency;

  const parentTiers: PricingObservation["tiers"] = [];
  if (listPriceRaw !== undefined) {
    parentTiers.push({
      kind: "list",
      amount: parseNumber(listPriceRaw, "list_price", firstIndex),
    });
  }
  if (salePriceRaw !== undefined) {
    parentTiers.push({
      kind: "sale",
      amount: parseNumber(salePriceRaw, "sale_price", firstIndex),
    });
  }

  if (parentTiers.length > 0) {
    if (parentCurrency === null || parentCurrency === undefined) {
      throw new Error(
        `csvAdapter: row ${firstIndex}: pricing currency missing (column blank and ctx.channelDefaultCurrency is null)`,
      );
    }
    pricing.push({
      productHint,
      channelCode,
      locale,
      source,
      sourceRecordId: parentRecordId,
      currency: parentCurrency,
      tiers: parentTiers,
      observedAt,
      ...(shared.artifactId !== undefined
        ? { artifactId: shared.artifactId }
        : {}),
    });
  }

  // --- Variants (every row with variant_* fields, including first row) ---

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

    const variantRecordId = variantSkuVal ?? variantGtinVal ?? parentRecordId;

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
      const isValidGtin = /^\d+$/.test(variantGtinVal) && [8, 12, 13, 14].includes(variantGtinVal.length);
      if (!isValidGtin) {
        shared.warnings.push({
          row: index,
          code: "INVALID_GTIN",
          message: `row ${index}: variant GTIN "${variantGtinVal}" is invalid (must be 8, 12, 13, or 14 digits)`,
          primaryIdentifier,
        });
      }
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

    // Pricing
    if (parentTiers.length > 0) {
      pricing.push({
        productHint,
        variantAxes,
        channelCode,
        locale,
        source,
        sourceRecordId: variantRecordId,
        currency: parentCurrency as string,
        tiers: parentTiers,
        observedAt,
        ...(shared.artifactId !== undefined
          ? { artifactId: shared.artifactId }
          : {}),
      });
    }

    // Inventory
    if (variantInvRaw !== undefined) {
      const qty = parseNumber(variantInvRaw, "variant_inventory_qty", index);
      inventory.push({
        productHint,
        variantAxes,
        channelCode,
        qty,
        source,
        sourceRecordId: variantRecordId,
        observedAt,
        ...(shared.artifactId !== undefined
          ? { artifactId: shared.artifactId }
          : {}),
      });
    }
  }

  // --- Images Extraction (Parent & Variants combined) -------------------
  interface ExtractedImage {
    url: string;
    altText?: string | undefined;
    rowIndex: number;
  }

  const extractedImages: ExtractedImage[] = [];
  const extractFromRow = (row: CsvRow, rowIndex: number, cols: string[], alt?: string) => {
    for (const col of cols) {
      const val = nonEmpty(row, col);
      if (val !== undefined) {
        const parts = val.startsWith("data:") ? [val] : val.split(",").map(p => p.trim()).filter(Boolean);
        for (const part of parts) {
          const isValidUrl = part.startsWith("http://") || part.startsWith("https://") || part.startsWith("data:image/");
          if (!isValidUrl) {
            shared.warnings.push({
              row: rowIndex,
              code: "INVALID_IMAGE_URL",
              message: `row ${rowIndex}: Image URL "${part.slice(0, 60)}" must start with http://, https://, or data:image/`,
              primaryIdentifier,
            });
          }
          extractedImages.push({
            url: part,
            altText: alt,
            rowIndex,
          });
        }
      }
    }
  };

  for (const { row, index } of groupRows) {
    const colorVal = nonEmpty(row, "variant_color");
    const sizeVal = nonEmpty(row, "variant_size");
    const axesParts: string[] = [];
    if (colorVal !== undefined) axesParts.push(`Color: ${colorVal}`);
    if (sizeVal !== undefined) axesParts.push(`Size: ${sizeVal}`);
    const altText = axesParts.length > 0 ? axesParts.join(", ") : undefined;

    extractFromRow(row, index, [
      "picture", "image_url", "image_urls",
      "variant_image_url", "variant_image", "variant_images"
    ], altText);
  }

  const dedupedMap = new Map<string, ExtractedImage>();
  for (const img of extractedImages) {
    const existing = dedupedMap.get(img.url);
    if (!existing || (!existing.altText && img.altText)) {
      dedupedMap.set(img.url, img);
    }
  }

  const finalImages = Array.from(dedupedMap.values()).map(img => ({
    url: img.url,
    ...(img.altText ? { altText: img.altText } : {}),
  }));

  if (finalImages.length > 0) {
    observations.push({
      attributeCode: "images",
      target: "parent",
      channelCode,
      localeCode: locale,
      source,
      sourceRecordId: parentRecordId,
      value: finalImages,
      confidence: DEFAULT_CONFIDENCE,
      observedAt,
    });
  }

  // --- Custom attributes (columns not in KNOWN_CSV_COLUMNS) ----------------
  // Emit each custom column as a custom.<column_name> observation. Values are
  // taken from the first row only (same as parent-level fields like title/brand).

  for (const col of customColumns) {
    const customVal = nonEmpty(firstRow, col);
    if (customVal !== undefined) {
      observations.push({
        attributeCode: `custom.${col}`,
        target: "parent",
        channelCode,
        localeCode: locale,
        source,
        sourceRecordId: parentRecordId,
        value: customVal,
        confidence: DEFAULT_CONFIDENCE,
        observedAt,
      });
    }
  }

  // --- Identity hint (for THIS group) ------------------------------------

  const hasVariants = groupRows.some((r) => hasAnyVariantField(r.row));
  const identityHint: IdentityHint = {
    ...(gtinVal !== undefined ? { gtin: gtinVal } : {}),
    ...(mpnVal !== undefined ? { mpn: mpnVal } : {}),
    ...(brandVal !== undefined ? { brand: brandVal } : {}),
    ...(titleVal !== undefined ? { titleForFuzzy: titleVal } : {}),
    primary_identifier: primaryIdentifier,
    targetIsVariant: hasVariants,
  };

  return {
    observations,
    pricingObservations: pricing,
    inventoryObservations: inventory,
    identityHint,
    rawPayload: groupRows.map((r) => r.row),
  };
}

/**
 * Cheap structural inspection for the upload handler: header list + row count
 * + delimiter, without building observations. Throws on fatal structural
 * problems (empty file, missing required column).
 */
export function inspectCsv(csvText: string): CsvInspectResult {
  const text = stripBom(csvText);
  const delimiter = detectDelimiter(text);
  const rows = parse(text, {
    columns: (headers: string[]) => headers.map(h => applyAlias(h.trim().toLowerCase().replace(/[-\s]/g, "_"))),
    skip_empty_lines: true,
    trim: true,
    delimiter
  }) as CsvRow[];
  if (rows.length === 0) throw new Error("csvAdapter: CSV contained no data rows");
  const headers = Object.keys(rows[0]!);
  for (const required of REQUIRED_COLUMNS) {
    if (!headers.includes(required)) {
      throw new Error(`csvAdapter: missing required column "${required}"`);
    }
  }
  return { headers, rowCount: rows.length, delimiter };
}

/**
 * Parse a CSV and produce ONE AdapterOutput per product group, collecting
 * per-group errors and file-level warnings instead of throwing on the first
 * bad row. Used by the csv-parse worker for per-product admit/stage.
 */
export function adaptGroups(input: CsvAdapterInput, ctx: AdaptContext): CsvAdaptGroupsResult {
  if (!input || typeof input.csv !== "string" || !input.filename) {
    throw new Error("csvAdapter: expected CsvAdapterInput { csv, filename, observedAt }");
  }
  const text = stripBom(input.csv);
  const delimiter = detectDelimiter(text);

  // Track original headers before aliasing so we can identify custom columns.
  let originalHeaders: string[] = [];
  const rows = parse(text, {
    columns: (headers: string[]) => {
      originalHeaders = headers.map(h => h.trim().toLowerCase().replace(/[-\s]/g, "_"));
      return originalHeaders.map(h => applyAlias(h));
    },
    skip_empty_lines: true,
    trim: true,
    delimiter
  }) as CsvRow[];

  const errors: CsvRowIssue[] = [];
  const warnings: CsvRowIssue[] = [];
  if (rows.length === 0) {
    throw new Error("csvAdapter: CSV contained no data rows");
  }

  const headerKeys = Object.keys(rows[0]!);
  for (const required of REQUIRED_COLUMNS) {
    if (!headerKeys.includes(required)) {
      throw new Error(`csvAdapter: missing required column "${required}"`);
    }
  }

  // Identify custom columns: headers that are not known AND not alias sources.
  // These will be emitted as custom.* observations.
  const customColumns: string[] = [];
  for (const h of originalHeaders) {
    const aliased = applyAlias(h);
    // If the header was aliased, it's now a known column — skip.
    if (aliased !== h) continue;
    // If it's a known column, skip.
    if ((KNOWN_CSV_COLUMNS as readonly string[]).includes(h)) continue;
    // If it's an alias source name, skip (already handled).
    if (ALIAS_SOURCE_NAMES.has(h)) continue;
    // Otherwise it's a custom/unknown column.
    customColumns.push(h);
  }

  for (const h of headerKeys) {
    if (!(KNOWN_CSV_COLUMNS as readonly string[]).includes(h) && !ALIAS_SOURCE_NAMES.has(h)) {
      // Only warn if it's not being captured as a custom column
      if (!customColumns.includes(h)) {
        const suggestion = suggestColumn(h);
        warnings.push({
          row: 0,
          code: "UNKNOWN_COLUMN",
          message: suggestion
            ? `unrecognized column "${h}" — did you mean "${suggestion}"?`
            : `unrecognized column "${h}" — stored as custom attribute`,
        });
      }
    }
  }

  const shared: GroupShared = {
    channelCode: input.channelCode ?? DEFAULT_CHANNEL,
    locale: ctx.channelDefaultLocale ?? "_unscoped",
    source: `csv:${input.filename}`,
    observedAt: input.observedAt instanceof Date ? input.observedAt : new Date(input.observedAt),
    ...(input.artifactId !== undefined ? { artifactId: input.artifactId } : {}),
    channelDefaultCurrency: ctx.channelDefaultCurrency,
    warnings,
  };

  const groups = new Map<string, IndexedRow[]>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowIndex = i + 1;
    const pid = nonEmpty(row, "primary_identifier");
    if (pid === undefined) {
      errors.push({ row: rowIndex, code: "EMPTY_PRIMARY_IDENTIFIER", message: `row ${rowIndex}: empty primary_identifier` });
      continue;
    }
    const existing = groups.get(pid);
    if (existing) existing.push({ row, index: rowIndex });
    else groups.set(pid, [{ row, index: rowIndex }]);
  }

  const results: CsvGroupResult[] = [];
  for (const [primaryIdentifier, groupRows] of groups) {
    try {
      const output = adaptGroup(primaryIdentifier, groupRows, shared, customColumns);
      results.push({ primaryIdentifier, rowIndices: groupRows.map((r) => r.index), output });
    } catch (err) {
      errors.push({
        row: groupRows[0]!.index,
        code: "GROUP_VALIDATION_FAILED",
        message: err instanceof Error ? err.message : String(err),
        primaryIdentifier,
      });
    }
  }

  return { groups: results, errors, warnings, rowCount: rows.length };
}

function adapt(input: unknown, ctx: AdaptContext): AdapterOutput {
  const envelope = input as CsvAdapterInput;
  const { groups, errors } = adaptGroups(envelope, ctx);
  if (errors.length > 0) {
    throw new Error(errors[0]!.message);
  }
  return {
    observations: groups.flatMap((g) => g.output.observations),
    pricingObservations: groups.flatMap((g) => g.output.pricingObservations),
    inventoryObservations: groups.flatMap((g) => g.output.inventoryObservations),
    identityHint: groups[0]?.output.identityHint ?? { targetIsVariant: false },
    rawPayload: groups.flatMap((g) => g.output.rawPayload as CsvRow[]),
  };
}

/**
 * CSV adapter — maps tenant-uploaded canonical CSV rows into the canonical
 * observation model.
 *
 * NOTE: this module deliberately does NOT call registerAdapter() at import
 * time. The package's main entry point (`src/index.ts`, wired up in Task 2.6)
 * is responsible for registration. This keeps test imports from polluting the
 * global registry.
 */
export const csvAdapter: SourceAdapter = {
  sourceKind: "csv",
  adapt,
};
