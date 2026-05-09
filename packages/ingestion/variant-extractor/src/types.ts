// HLD §8 / §20 — Variant Extractor output types.

export interface VariantSpec {
  /** Deterministic hash of sorted normalized axis values */
  variantKey: string;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  currency: string | null;
  inventoryQuantity: number | null;
  /** Canonical axis values e.g. { Color: "Red", Size: "M" } */
  variantAxes: Record<string, string>;
}

export interface VariantExtractionResult {
  /** Fields belonging to the parent product (non-variant) */
  parentFields: Record<string, unknown>;
  variants: VariantSpec[];
}
