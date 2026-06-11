// Content-quality score — the honest "is the listing content actually good?"
// number, the counterpart to the validator's spec completeness.
//
// A content field COUNTS toward its tier only when it is present, valid, meets
// its minimum bar (e.g. >= 4 key_features), and is not contradicted — i.e. real,
// grounded content, not a stub. Tier-weighted exactly like spec completeness so
// the two sub-scores are directly comparable on one 0..100 scale.

import type { Completeness, Tier } from "@aonex/taxonomy-validator";
import { meetsContentBar } from "./content-validate.js";
import type { EnrichField, FieldResult } from "./types.js";

const TIER_SHARE: Record<Tier, number> = { required: 0.7, recommended: 0.25, optional: 0.05 };

/** Does this field's result represent real, countable content? */
function counts(field: EnrichField, r: FieldResult | undefined): boolean {
  if (!r) return false;
  if (r.status !== "ok" && r.status !== "coerced") return false;
  if (r.grounding === "contradicted") return false;
  return meetsContentBar(field, r.normalized ?? r.raw);
}

/** Tier-weighted content score over the content fields, using each field's weight
 *  within its tier. `resultByKey` is the per-field outcome to grade (e.g. proposable
 *  content, or the content already known on the product). */
export function scoreContent(
  fields: EnrichField[],
  resultByKey: Map<string, FieldResult>
): Completeness {
  const tiers: Tier[] = ["required", "recommended", "optional"];
  const cov: Record<Tier, number> = { required: 0, recommended: 0, optional: 0 };

  for (const tier of tiers) {
    const inTier = fields.filter((f) => f.tier === tier);
    const totW = inTier.reduce((s, f) => s + (f.weight ?? 0.4), 0);
    if (totW === 0) continue;
    const gotW = inTier.reduce((s, f) => s + (counts(f, resultByKey.get(f.key)) ? f.weight ?? 0.4 : 0), 0);
    cov[tier] = gotW / totW;
  }

  let weighted = 0;
  let totalShare = 0;
  for (const tier of tiers) {
    if (fields.some((f) => f.tier === tier)) {
      totalShare += TIER_SHARE[tier];
      weighted += TIER_SHARE[tier] * cov[tier];
    }
  }
  return {
    required: cov.required,
    recommended: cov.recommended,
    optional: cov.optional,
    score: totalShare === 0 ? 0 : Math.round((weighted / totalShare) * 10000) / 100,
  };
}
