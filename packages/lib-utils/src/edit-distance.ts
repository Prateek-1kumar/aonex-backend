// Levenshtein edit distance + normalized similarity.
//
// The single shared implementation — previously duplicated in
// taxonomy-validator (fuzzy enum coercion), the CSV source adapter
// ("did you mean" header suggestions) and the deduplicator (title
// similarity). Levenshtein is deliberately conservative (ADR-006:
// "never auto-merge on title alone") and needs no dependencies.

/** Levenshtein distance between two strings. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array<number>(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
    }
  }
  return d[m]![n]!;
}

/** Edit-distance similarity 0..1 where 1 = identical (case/whitespace-folded). */
export function normalizedSimilarity(a: string, b: string): number {
  const aNorm = a.toLowerCase().trim();
  const bNorm = b.toLowerCase().trim();
  if (aNorm === bNorm) return 1.0;
  const maxLen = Math.max(aNorm.length, bNorm.length);
  if (maxLen === 0) return 1.0;
  return 1 - editDistance(aNorm, bNorm) / maxLen;
}
