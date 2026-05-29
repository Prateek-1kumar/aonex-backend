const PRICE_FIELDS = new Set(["base_price", "price", "currency_amount"]);

function normStr(v: string | number): string {
  return String(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Compare an extracted value to its golden label for one field. Prices use a
 *  1% relative tolerance; everything else uses normalized string equality. */
export function fieldsMatch(
  field: string,
  expected: string | number,
  extracted: string | number | null
): boolean {
  if (extracted === null || extracted === undefined) return false;
  if (PRICE_FIELDS.has(field)) {
    const e = Number(expected);
    const a = Number(extracted);
    if (!Number.isFinite(e) || !Number.isFinite(a) || e === 0) return e === a;
    return Math.abs(e - a) / Math.abs(e) <= 0.01;
  }
  return normStr(expected) === normStr(extracted);
}
