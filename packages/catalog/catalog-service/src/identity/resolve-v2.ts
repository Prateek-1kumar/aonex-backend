// packages/catalog/catalog-service/src/identity/resolve-v2.ts
// Phase 2: strong-key-or-Lab resolution (spec D2). Auto-merge ONLY on a shared
// strong key with no variant conflict; otherwise propose a Lab candidate (the
// human confirms or rejects); otherwise create a brand-new product. Absence of
// any match is NOT a Lab event — it's just a new product.

import { matchOnStrong, type Identifier } from "./identifier-set.js";
import { variantConflict } from "./variant-guard.js";

export interface CandidateRow {
  productId: string;
  ids: Identifier[];
  variant: Record<string, string>;
  fuzzyScore?: number;
}

export interface ResolutionInput {
  incomingIds: Identifier[];
  incomingVariant: Record<string, string>;
  candidates: CandidateRow[];
}

export interface ResolutionDecision {
  action: "auto_merge" | "propose_lab" | "create_new";
  productId?: string;
  reason: string;
}

export function decideResolution(input: ResolutionInput): ResolutionDecision {
  // Strong-key candidates (the only auto-merge basis, D2).
  const strong = input.candidates.filter((c) => matchOnStrong(input.incomingIds, c.ids));
  for (const c of strong) {
    if (!variantConflict(input.incomingVariant, c.variant)) {
      return {
        action: "auto_merge",
        productId: c.productId,
        reason: "strong_key_no_variant_conflict",
      };
    }
  }
  // Strong-but-variant-conflict OR fuzzy candidates → human confirmation.
  const proposable =
    strong.length > 0 || input.candidates.some((c) => (c.fuzzyScore ?? 0) >= 0.5);
  if (proposable) {
    return {
      action: "propose_lab",
      reason: strong.length ? "variant_conflict" : "fuzzy_candidate",
    };
  }
  return { action: "create_new", reason: "no_candidate" };
}
