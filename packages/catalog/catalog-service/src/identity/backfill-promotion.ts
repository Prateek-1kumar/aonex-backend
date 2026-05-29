// Phase 2 Task 9: D3 backfill promotion rule. The ONLY code path allowed to set
// corroborated=true. Spec: >=2 independent providers agree on {type,value} AND
// round-trip verification passes. The demote path (corroborated -> false on
// higher-authority strong conflict) is Task 12.

import { roundTripMatches } from "@aonex/gtin-backfill";

export interface PromoteInput {
  gtin: string;
  ours: { title: string; brand: string };
  /** Distinct source strings that produced this gtin (e.g. "backfill:icecat",
   *  "backfill:upcitemdb", "live:croma"). Independence is keyed off the
   *  REGISTRY name (second segment after ':'). */
  sources: string[];
  registryProduct: { title: string; brand: string };
}

export interface PromoteResult {
  promote: boolean;
  reason: string;
}

/** D3: candidate -> strong iff >=2 independent agreeing sources AND round-trip match.
 *  "Independent" = distinct registry name (the segment after ':'). Single source
 *  or round-trip mismatch -> stay weak. */
export function promoteBackfill(i: PromoteInput): PromoteResult {
  const independent = new Set(
    i.sources
      .map((s) => s.split(":")[1])
      .filter((p): p is string => typeof p === "string" && p.length > 0)
  );
  if (independent.size < 2) {
    return { promote: false, reason: "needs >=2 sources for corroboration" };
  }
  if (!roundTripMatches(i.ours, i.registryProduct)) {
    return { promote: false, reason: "round-trip mismatch" };
  }
  return { promote: true, reason: "corroborated + round-trip ok" };
}
