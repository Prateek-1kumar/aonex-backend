// Policy-engine detector — missing required attribute.
//
// detectMissingRequiredAttribute fires when core fields (title / base_price) or
// any of input.categoryRequiredAttributes are absent from the facts; core gaps
// raise severity to high. One rule in the router.ts array; emits a
// `missing_required_attribute` ReviewTaskSignal.

import type { Detector, ReviewTaskSignal, RouterInput } from "../types.js";

export const detectMissingRequiredAttribute: Detector = (input: RouterInput): ReviewTaskSignal | null => {
  const have = new Set(input.facts.map((f) => f.rawKey));
  const missing = input.categoryRequiredAttributes.filter((a) => !have.has(a));
  const coreMissing: string[] = [];
  if (!input.payload.title) coreMissing.push("title");
  if (input.payload.basePrice == null) coreMissing.push("base_price");
  const allMissing = [...coreMissing, ...missing];
  if (allMissing.length === 0) return null;
  return {
    signalKind: "missing_required_attribute",
    severity: coreMissing.length > 0 ? "high" : "medium",
    fieldName: allMissing[0]!,
    clusterDimensions: { domain: input.domain, category: input.category.path ?? "" },
    payload: {
      evidence: { missing: allMissing, category: input.category.path },
      reasonText: `Missing required: ${allMissing.join(", ")}`,
      affectedFields: allMissing,
    },
  };
};
