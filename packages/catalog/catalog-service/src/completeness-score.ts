// Server-authoritative completeness scoring (Catalog enrichment Phase 0).
//
// Computes the 0..100 quality score persisted on catalog_products
// (completeness_score + score_breakdown). The reconciler calls this whenever
// winning_values changes, so the "Needs Enrichment" tab and the enrich before/
// after delta read one consistent, server-owned number (replacing the frontend's
// naive 5-field health calc).
//
// Pure logic here; the DB reads (winning_values + the generated commerce-fact
// columns) live in reconciler/sync.ts, which passes the facts in.

import {
  getArchetype,
  scoreCompletenessPercent,
  type CompletenessPercent,
} from "@aonex/archetypes";

export interface ScoreFacts {
  /** catalog_products.family — the archetype id; null/unknown -> generic. */
  family: string | null;
  /** Reconciled winners (winning_values; _meta is ignored). */
  winningValues: Record<string, unknown> | null;
  /** Commerce facts live OUTSIDE winning_values (side tables / identity), so
   *  presence is derived from the generated columns and passed in. */
  hasPrice: boolean;
  hasCurrency: boolean;
  hasIdentifier: boolean;
  hasTitle: boolean;
}

const EMPTY_BREAKDOWN: CompletenessPercent = {
  percent: 0,
  byTier: {
    required: { presentWeight: 0, totalWeight: 0, percent: 0 },
    recommended: { presentWeight: 0, totalWeight: 0, percent: 0 },
    optional: { presentWeight: 0, totalWeight: 0, percent: 0 },
  },
};

/** The set of attribute codes considered "present" for an archetype: the
 *  reconciled winners plus the out-of-band commerce facts. */
export function presentAttributes(f: ScoreFacts): Set<string> {
  const present = new Set<string>();
  const wv = f.winningValues ?? {};
  for (const k of Object.keys(wv)) if (k !== "_meta") present.add(k);
  if (f.hasTitle) present.add("title");
  if (f.hasPrice) present.add("base_price");
  if (f.hasCurrency) present.add("currency");
  if (f.hasIdentifier) present.add("identifier");
  return present;
}

/** Completeness score (0..100) + per-tier breakdown. Falls back to the generic
 *  archetype when family is null/unknown so every product scores. */
export function computeCompletenessScore(f: ScoreFacts): CompletenessPercent {
  const arch = getArchetype(f.family ?? "generic") ?? getArchetype("generic");
  if (!arch) return EMPTY_BREAKDOWN;
  return scoreCompletenessPercent(arch, presentAttributes(f));
}
