// Catalog admission gate — archetype completeness scoring.
//
// evaluateCompleteness builds the set of present canonical fields from an
// AdapterOutput (observations + identity + pricing) and scores it against the
// archetype's required/recommended attributes, returning an admit verdict plus
// the missing keys. Used by admit-or-stage to decide catalog vs. anomaly lab.

import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import { getArchetype, scoreCompleteness } from "@aonex/archetypes";
import { latestObservationValue } from "../observation-helpers.js";

export interface CompletenessVerdict {
  admit: boolean;
  score: number;
  missingRequired: string[];
  missingRecommended: string[];
}

/** Build the set of "present" canonical fields from an AdapterOutput, then score
 *  it against the archetype. Price presence comes from pricingObservations;
 *  identity from identityHint. */
export function evaluateCompleteness(input: {
  adapterOutput: AdapterOutput;
  archetypeId: string;
  threshold: number;
  identifierExists: boolean;
}): CompletenessVerdict {
  const { adapterOutput: out } = input;
  const arch = getArchetype(input.archetypeId);
  if (!arch) {
    return { admit: false, score: 0, missingRequired: [], missingRecommended: [] };
  }

  const present = new Set<string>();
  for (const o of out.observations) {
    if (o.value != null && String(o.value).trim() !== "") present.add(o.attributeCode);
  }
  if (out.identityHint.brand) present.add("brand");
  // Translate identityHint's identifier-bearing fields to the canonical "identifier" present-set key
  // (matches the hardFloor's identifier|gtin|mpn synonym set + retains primary_identifier semantics from
  // the legacy hasIdentifier in evaluate-gate.ts).
  if (out.identityHint.gtin || out.identityHint.mpn || out.identityHint.primary_identifier) {
    present.add("identifier");
  }
  const hasPrice = out.pricingObservations.some(
    (p) => p.currency && p.tiers?.some((t) => typeof t.amount === "number" || typeof t.total === "number")
  );
  if (hasPrice) {
    present.add("base_price");
    present.add("currency");
  }
  if (latestObservationValue(out, "title")) present.add("title");

  const r = scoreCompleteness(arch, present, {
    threshold: input.threshold,
    identifierExists: input.identifierExists,
  });
  return {
    admit: r.hardFloorOk && r.meetsThreshold,
    score: r.score,
    missingRequired: r.missingRequired,
    missingRecommended: r.missingRecommended,
  };
}
