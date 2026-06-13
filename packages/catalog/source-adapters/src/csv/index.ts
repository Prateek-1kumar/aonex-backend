// CSV source adapter — normalizes a tenant-uploaded canonical CSV into observations.
//
// Exports csvAdapter (sourceKind "csv"), plus adaptGroups() which groups rows by
// primary_identifier into one AdapterOutput per product (collecting per-group errors
// and column warnings) and inspectCsv() for cheap header/row-count preflight. Handles
// header aliasing, custom-column passthrough, GTIN validation, and image extraction.
// Consumed by the csv-parse worker; registered via the package's src/index.ts.

import { parse } from "csv-parse/sync";
import type { ArtifactId } from "@aonex/types";
import { editDistance } from "@aonex/lib-utils";
import { detectDelimiter, type Delimiter } from "./delimiter.js";
import {
  buildCustomAttrs,
  buildImages,
  buildParentObservations,
  buildParentPricing,
  buildVariants,
  hasAnyVariantField,
  nonEmpty,
  type CsvRow,
  type CsvRowIssue,
  type GroupShared,
  type IndexedRow,
} from "./group-builders.js";
import type {
  SourceAdapter,
  AdapterOutput,
  AdaptContext,
  IdentityHint,
} from "../types.js";

export type { CsvRowIssue } from "./group-builders.js";

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
  "variant_list_price", "variant_sale_price", "variant_currency",
  "picture", "image_url", "image_urls", "variant_image_url", "variant_image", "variant_images",
] as const;

/** Hard cap on data rows — guards against a multi-GB upload OOMing the sync
 *  parser/event loop. Beyond this the upload must be chunked (streaming is a
 *  follow-up; see the worker). Tunable but deliberately generous. */
export const MAX_CSV_ROWS = 50_000;

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
  delimiter: Delimiter;
}

/** Default channel code when caller doesn't pass one. */
const DEFAULT_CHANNEL = "csv";

/** Required header columns. */
const REQUIRED_COLUMNS = ["primary_identifier"] as const;

/** Strip a UTF-8 BOM if present. Excel/Sheets prepend one and it corrupts the first header. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Cheap upper-bound row-count guard before the (synchronous) full-file parse —
 *  a newline scan over-counts on quoted newlines but never under-counts, so it
 *  safely rejects pathologically large uploads early. */
function assertWithinRowCap(text: string): void {
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      if (++newlines > MAX_CSV_ROWS) {
        throw new Error(`csvAdapter: file exceeds ${MAX_CSV_ROWS} rows — split the upload into smaller batches`);
      }
    }
  }
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

/**
 * Build the AdapterOutput for ONE product group by composing the focused
 * builders (see group-builders.ts). Throws on a row-level validation error
 * (caught per-group by adaptGroups so one bad group does not abort the file).
 * Identity hint is for THIS group only.
 */
function adaptGroup(
  primaryIdentifier: string,
  groupRows: IndexedRow[],
  shared: GroupShared,
  customColumns: string[] = [],
): AdapterOutput {
  const parent = buildParentObservations(primaryIdentifier, groupRows, shared);
  const parentPricing = buildParentPricing(primaryIdentifier, groupRows, shared);
  const variants = buildVariants(primaryIdentifier, groupRows, parentPricing, shared);
  const imageObservations = buildImages(primaryIdentifier, groupRows, shared);
  const customObservations = buildCustomAttrs(primaryIdentifier, groupRows, customColumns, shared);

  const { title, brand, mpn, gtin } = parent.fields;
  const identityHint: IdentityHint = {
    ...(gtin !== undefined ? { gtin } : {}),
    ...(mpn !== undefined ? { mpn } : {}),
    ...(brand !== undefined ? { brand } : {}),
    ...(title !== undefined ? { titleForFuzzy: title } : {}),
    primary_identifier: primaryIdentifier,
    targetIsVariant: groupRows.some((r) => hasAnyVariantField(r.row)),
  };

  return {
    observations: [
      ...parent.observations,
      ...variants.observations,
      ...imageObservations,
      ...customObservations,
    ],
    pricingObservations: [...parentPricing.pricing, ...variants.pricing],
    inventoryObservations: variants.inventory,
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
  assertWithinRowCap(text);
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
  assertWithinRowCap(text);
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
    if ((KNOWN_CSV_COLUMNS as readonly string[]).includes(h) || ALIAS_SOURCE_NAMES.has(h)) continue;
    const suggestion = suggestColumn(h);
    if (suggestion) {
      // A near-miss of a known column is almost certainly a typo (e.g.
      // "primary_identifer"). Surface the suggestion EVEN THOUGH we also keep it
      // as a custom attribute, so the user can correct the header — previously
      // this warning was dead code because every unknown header is a custom one.
      warnings.push({
        row: 0,
        code: "UNKNOWN_COLUMN",
        message: `unrecognized column "${h}" — did you mean "${suggestion}"?`,
      });
    } else if (!customColumns.includes(h)) {
      warnings.push({
        row: 0,
        code: "UNKNOWN_COLUMN",
        message: `unrecognized column "${h}" — stored as custom attribute`,
      });
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
