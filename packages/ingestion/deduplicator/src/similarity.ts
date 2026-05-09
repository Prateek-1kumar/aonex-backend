// Title similarity: Levenshtein-normalized. No external dependency.
// Choice documented in ADR-006: Levenshtein is conservative (HLD §13 requires
// "never auto-merge on title alone") and requires zero new packages.
// Trigram/cosine would be faster on long strings but adds complexity.

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

/** Returns 0..1 where 1 = identical strings, 0 = completely different */
export function normalizedSimilarity(a: string, b: string): number {
  const aNorm = a.toLowerCase().trim();
  const bNorm = b.toLowerCase().trim();
  if (aNorm === bNorm) return 1.0;
  const maxLen = Math.max(aNorm.length, bNorm.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(aNorm, bNorm) / maxLen;
}
