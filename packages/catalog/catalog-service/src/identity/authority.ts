// Phase 2 Task 12: per-source field authority for identity writes (spec C4).
// Pure functions. The integration guard lives in identity-policy.ts —
// applyIdentityObservation short-circuits when canSourceWrite returns false.
//
// Rank order: connector (direct merchant feeds, highest) > csv > link > backfill.
// Anything else maps to rank 0 (below all known sources). A scrape (link) cannot
// overwrite a connector-asserted GTIN; a connector can.

export type AuthorityRank = 0 | 1 | 2 | 3 | 4;

const RANK_BY_PREFIX: Record<string, AuthorityRank> = {
  connector: 4,
  csv:       3,
  link:      2,
  backfill:  1,
};

/** Numeric authority rank derived from the source string's prefix (before ':').
 *  Unknown prefixes get 0 — treated as below all known sources. */
export function authorityRank(source: string): AuthorityRank {
  if (!source) return 0;
  const prefix = source.split(":")[0] ?? "";
  return RANK_BY_PREFIX[prefix] ?? 0;
}

/** Can the incoming source overwrite the field's current value?
 *  Rules: no current source → always yes (first write); else incoming rank
 *  must be ≥ current rank. Equal-rank overwrite is allowed (e.g. one connector
 *  updating another connector's value — the policy gate in applyIdentityObservation
 *  is what blocks disagreeing equal-rank writes). */
export function canSourceWrite(currentSource: string | null | undefined, incomingSource: string): boolean {
  if (!currentSource) return true;
  return authorityRank(incomingSource) >= authorityRank(currentSource);
}
