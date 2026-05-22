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

function parseNumber(raw: string, col: string, rowIndex: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(
      `csvAdapter: row ${rowIndex}: ${col} is not a number (got "${raw}")`,
    );
  }
  return n;
}

function adapt(input: unknown, ctx: AdaptContext): AdapterOutput {
  const envelope = input as CsvAdapterInput;
  if (!envelope || typeof envelope.csv !== "string" || !envelope.filename) {
    throw new Error(
      "csvAdapter: expected CsvAdapterInput { csv, filename, observedAt }",
    );
  }

  const rows = parse(envelope.csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];

  if (rows.length === 0) {
    throw new Error("csvAdapter: CSV contained no data rows");
  }

  // Validate required columns are present in the header. csv-parse with
  // columns:true infers headers from the first record's keys, so we can read
  // them off row 0.
  const headerKeys = Object.keys(rows[0]!);
  for (const required of REQUIRED_COLUMNS) {
    if (!headerKeys.includes(required)) {
      throw new Error(`csvAdapter: missing required column "${required}"`);
    }
  }

  const channelCode = envelope.channelCode ?? DEFAULT_CHANNEL;
  const locale = ctx.channelDefaultLocale ?? "_unscoped";
  const source = `csv:${envelope.filename}`;
  const observedAt =
    envelope.observedAt instanceof Date
      ? envelope.observedAt
      : new Date(envelope.observedAt);

  // Group rows by primary_identifier, preserving original 1-based row indices
  // so error messages remain meaningful even after grouping.
  interface IndexedRow {
    row: CsvRow;
    /** 1-based row number, excluding the header (so first data row is 1). */
    index: number;
  }
  const groups = new Map<string, IndexedRow[]>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowIndex = i + 1;
    const pid = nonEmpty(row, "primary_identifier");
    if (pid === undefined) {
      throw new Error(`csvAdapter: row ${rowIndex}: empty primary_identifier`);
    }
    const existing = groups.get(pid);
    if (existing) {
      existing.push({ row, index: rowIndex });
    } else {
      groups.set(pid, [{ row, index: rowIndex }]);
    }
  }

  const observations: CanonicalObservation[] = [];
  const pricing: PricingObservation[] = [];
  const inventory: InventoryObservation[] = [];

  // identityHint is built from the *first* group only — when a CSV mixes
  // multiple parents the hint reflects the first product. Downstream the
  // hint is per-artifact, so this is the natural choice.
  let identityHint: IdentityHint | null = null;

  for (const [primaryIdentifier, groupRows] of groups) {
    const first = groupRows[0]!;
    const firstRow = first.row;
    const firstIndex = first.index;
    const productHint = primaryIdentifier;
    const parentRecordId = primaryIdentifier;

    // --- Parent observations (first row in group only) ----------------------

    const titleVal = nonEmpty(firstRow, "title");
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

    const brandVal = nonEmpty(firstRow, "brand");
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
        attributeCode: "category",
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
    // so the canonical reconciler doesn't have to guess the unit.
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
        // Only emit unit in extras when explicitly provided — silent
        // "kg default" would be a footgun.
        ...(weightUnitVal !== undefined
          ? { extras: { unit: weightUnitVal } }
          : {}),
      });
    }

    // --- Parent pricing (first row in group) -------------------------------

    const listPriceRaw = nonEmpty(firstRow, "list_price");
    const salePriceRaw = nonEmpty(firstRow, "sale_price");
    const parentCurrency = nonEmpty(firstRow, "currency") ?? ctx.channelDefaultCurrency;

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
        ...(envelope.artifactId !== undefined
          ? { artifactId: envelope.artifactId }
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

      // Pricing: variants inherit parent tiers + currency in v1. Emit a
      // pricing observation with variantAxes set so the reconciler can attach
      // it to the right variant.
      if (parentTiers.length > 0) {
        // parentCurrency null/undefined was already rejected above when
        // parent pricing was emitted, so it's guaranteed defined here.
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
          ...(envelope.artifactId !== undefined
            ? { artifactId: envelope.artifactId }
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
          ...(envelope.artifactId !== undefined
            ? { artifactId: envelope.artifactId }
            : {}),
        });
      }
    }

    // --- Identity hint (built from first group) ----------------------------

    if (identityHint === null) {
      const hasVariants = groupRows.some((r) => hasAnyVariantField(r.row));
      identityHint = {
        ...(gtinVal !== undefined ? { gtin: gtinVal } : {}),
        ...(mpnVal !== undefined ? { mpn: mpnVal } : {}),
        ...(brandVal !== undefined ? { brand: brandVal } : {}),
        ...(titleVal !== undefined ? { titleForFuzzy: titleVal } : {}),
        targetIsVariant: hasVariants,
      };
    }
  }

  return {
    observations,
    pricingObservations: pricing,
    inventoryObservations: inventory,
    identityHint: identityHint ?? { targetIsVariant: false },
    rawPayload: rows,
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
