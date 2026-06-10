// Helpers for reading catalog_products.winning_values — the reconciled,
// channel/locale-scoped value structure {attribute: {channel: {locale: value}}}.
//
// Previously copy-pasted into scripts/seed/classify-catalog.ts and
// scripts/eval/run-enrichment-eval.ts; this is the single implementation.

/** winning_values keys that aren't product attributes. */
export const NON_ATTR_KEYS = new Set([
  "title",
  "category_path",
  "_meta",
  "images",
  "description",
  "description_long",
  "description_short",
]);

/** winning_values are channel/locale-scoped: {channel: {locale: value}}. Take the first. */
export function firstScoped(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v ?? null;
  const ch = Object.values(v as Record<string, unknown>)[0];
  if (ch == null || typeof ch !== "object") return ch ?? null;
  return Object.values(ch as Record<string, unknown>)[0] ?? null;
}

/** Flatten a scoped value to display text (arrays joined as a breadcrumb). */
export function asText(v: unknown): string {
  return Array.isArray(v) ? v.join(" > ") : v == null ? "" : String(v);
}

/** Extract the plain attribute map from winning_values: drop non-attribute
 *  keys, unwrap the first channel/locale scope, skip empty values. */
export function flattenWinningAttrs(winningValues: Record<string, unknown>): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(winningValues)) {
    if (NON_ATTR_KEYS.has(k)) continue;
    const s = firstScoped(v);
    if (s != null && s !== "") attrs[k] = s;
  }
  return attrs;
}
