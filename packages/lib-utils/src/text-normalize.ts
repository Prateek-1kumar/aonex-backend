// Shared text normalization (tokens, sets, numerals, Jaccard) for matching,
// grounding and retrieval. The single source of truth so every layer agrees on
// what "the same token" means; otherwise alias matching and grounding drift.

/** Lowercase, fold separators to spaces, keep alphanumerics (digits matter for
 *  specs like "128gb"/"225/45r17"), collapse whitespace. */
export function normalizeText(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalized token list (alphanumeric runs). */
export function tokens(s: unknown): string[] {
  const n = normalizeText(s);
  return n ? n.split(" ") : [];
}

/** Token set, for overlap checks. */
export function tokenSet(s: unknown): Set<string> {
  return new Set(tokens(s));
}

/** Numerals appearing in a string, e.g. "128GB" -> ["128"], "225/45R17" -> ["225","45","17"]. */
export function numerals(s: unknown): string[] {
  return String(s ?? "").match(/\d+(?:\.\d+)?/g) ?? [];
}

/** Jaccard similarity of two token sets (0..1). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Flatten an arbitrary attribute value to comparable text (arrays/objects too). */
export function valueToText(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(valueToText).join(" ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.values(o).map(valueToText).join(" ");
  }
  return String(v);
}
