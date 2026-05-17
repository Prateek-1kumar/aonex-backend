// Pure comparison utility for the spine-vs-legacy shadow-mode parity check.
// Compares two canonical rows field-by-field, drilling into jsonb objects one
// level deep so callers get granular diff paths like "attributes_json.size"
// rather than just "attributes_json". Used by Phase 6 rollout wiring; this
// module has no side effects and no external dependencies.

export interface ComparisonResult {
  differingFields: string[];
  diffRatio: number;
}

const NON_TRIVIAL_FIELDS = new Set([
  "title",
  "brand",
  "gtin",
  "modelNumber",
  "manufacturerPartNumber",
  "basePrice",
  "currency",
  "weightGrams",
  "dimensionsCm",
  "canonicalCategory",
  "categorySchemaVersion",
  "categoryConfidence",
  "confidenceScore",
  "attributes_json",
]);

export function compareCanonicalRows(
  legacy: Record<string, unknown>,
  spine: Record<string, unknown>
): ComparisonResult {
  const differingFields: string[] = [];
  const allKeys = new Set([...Object.keys(legacy), ...Object.keys(spine)]);
  let comparedCount = 0;

  for (const key of allKeys) {
    if (!NON_TRIVIAL_FIELDS.has(key)) continue;
    comparedCount++;
    const a = legacy[key];
    const b = spine[key];

    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
      // Shallow-compare jsonb fields key-by-key so the diff path is specific
      // (e.g. "attributes_json.size") rather than just the top-level key.
      const subKeys = new Set([
        ...Object.keys(a as Record<string, unknown>),
        ...Object.keys(b as Record<string, unknown>),
      ]);
      for (const sub of subKeys) {
        if (
          JSON.stringify((a as Record<string, unknown>)[sub]) !==
          JSON.stringify((b as Record<string, unknown>)[sub])
        ) {
          differingFields.push(`${key}.${sub}`);
        }
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      differingFields.push(key);
    }
  }

  return {
    differingFields,
    diffRatio: comparedCount === 0 ? 0 : differingFields.length / comparedCount,
  };
}
