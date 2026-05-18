// Sanity validators — soft checks producing warnings + value normalization.
// Failures DO NOT block output; they get attached to _extraction_meta.

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
  if (!/^\d{8,14}$/.test(gtin)) {
    return { value: gtin, warnings: [{ field: "gtin", reason: "format invalid" }] };
  }
  // mod-10 checksum (GS1 algorithm — works for GTIN-8/12/13/14)
  const digits = gtin.split("").map(Number);
  const check = digits.pop()!;
  // From right-to-left of remaining digits: alternating *3, *1
  let sum = 0;
  for (let i = digits.length - 1, mul = 3; i >= 0; i--, mul = mul === 3 ? 1 : 3) {
    sum += digits[i]! * mul;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === check
    ? { value: gtin, warnings: [] }
    : { value: gtin, warnings: [{ field: "gtin", reason: "checksum failed" }] };
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
