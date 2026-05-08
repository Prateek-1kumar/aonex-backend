// canonicalStringify — deterministic JSON serialization for hashing.
// Mirrors Nango's `stringifyStable` so checksums computed on either
// side of the boundary collide on the same logical record.
//
// Rules:
//  - Object keys sorted lexicographically at every level.
//  - Arrays preserve order.
//  - undefined values dropped.
//  - No trailing whitespace, no \n.

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
