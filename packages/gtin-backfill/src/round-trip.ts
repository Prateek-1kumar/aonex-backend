// Phase 2 Task 7: D3 round-trip verifier. A backfilled GTIN is only trustworthy
// if the registry's looked-up product matches OURS — brand must match
// (normalized), title token-overlap ≥ 0.6.

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenOverlap(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter(Boolean));
  const B = new Set(norm(b).split(" ").filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  const inter = [...A].filter((t) => B.has(t)).length;
  return inter / Math.min(A.size, B.size);
}

/** D3 guard: a backfilled GTIN is only trustworthy if the registry's product
 *  matches ours. Brand must match (normalized); title token-overlap must ≥ 0.6. */
export function roundTripMatches(
  ours: { title: string; brand: string },
  registry: { title: string; brand: string }
): boolean {
  if (norm(ours.brand) !== norm(registry.brand)) return false;
  return tokenOverlap(ours.title, registry.title) >= 0.6;
}
