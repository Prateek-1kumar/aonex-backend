// Sanity validators — soft checks producing warnings + value normalization.
// Failures DO NOT block output; they get attached to _extraction_meta.

import { gtinIssue } from "@aonex/lib-utils";

export interface ValidationWarning {
  field: string;
  reason: string;
}

export interface ValidationResult<T> {
  value: T;
  warnings: ValidationWarning[];
}

export interface PricingInput {
  list_price: number | null;
  sale_price: number | null;
  currency: string | null;
}

export function validatePricing(p: PricingInput): ValidationResult<PricingInput> {
  const warnings: ValidationWarning[] = [];
  let list_price = p.list_price;
  let sale_price = p.sale_price;

  if (sale_price != null && list_price != null && sale_price > list_price) {
    warnings.push({ field: "pricing", reason: "sale_price > list_price (swapped)" });
    [list_price, sale_price] = [sale_price, list_price];
  }

  if (list_price != null && list_price <= 0) {
    warnings.push({ field: "pricing.list_price", reason: "non-positive" });
    list_price = null;
  }

  return { value: { list_price, sale_price, currency: p.currency }, warnings };
}

export function validateGtin(gtin: string | null): ValidationResult<string | null> {
  if (!gtin) return { value: null, warnings: [] };
  // Shared strict GS1 validator: exact 8/12/13/14 length + mod-10 check digit.
  // (Previously this accepted lengths 9-11, which are not valid GTIN formats.)
  const issue = gtinIssue(gtin);
  if (issue === null) return { value: gtin, warnings: [] };
  const reason = issue === "checksum" ? "checksum failed" : "format invalid";
  return { value: gtin, warnings: [{ field: "gtin", reason }] };
}

export function dedupeVariantSkus<T extends { sku: string | null }>(
  variants: T[]
): ValidationResult<T[]> {
  const seen = new Set<string>();
  const out: T[] = [];
  const warnings: ValidationWarning[] = [];
  for (const v of variants) {
    if (v.sku && seen.has(v.sku)) {
      warnings.push({ field: "variants", reason: `duplicate sku ${v.sku}` });
      continue;
    }
    if (v.sku) seen.add(v.sku);
    out.push(v);
  }
  return { value: out, warnings };
}
