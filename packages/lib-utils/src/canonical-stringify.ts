// Deterministic JSON serialization for hashing: keys sorted at every level,
// array order kept, undefined dropped, no whitespace. Mirrors Nango's
// `stringifyStable` so checksums collide for the same logical record across the
// boundary.

export function canonicalStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + canonicalStringify(v));
  }
  return "{" + parts.join(",") + "}";
}
