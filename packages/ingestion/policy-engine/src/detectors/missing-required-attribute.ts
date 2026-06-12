// Policy-engine detector — missing required attribute.
//
// detectMissingRequiredAttribute fires ONLY when a CORE field (title /
// base_price) is absent — those are genuinely un-shippable. Category-specific
// required attributes (size, colour, material, …) deliberately do NOT trip a
// review here: CANONICAL_MINIMUM declares them "nice-to-have, not gating", and
// the grounded enrichment engine is what fills them AFTER admit. Gating on them
// pre-enrichment would send every product to manual review for data the next
// automated step produces — the exact "human-in-loop on everything" problem the
// auto-categorize workflow removes. Emits a `missing_required_attribute` signal.

import type { Detector, ReviewTaskSignal, RouterInput } from "../types.js";

export const detectMissingRequiredAttribute: Detector = (input: RouterInput): ReviewTaskSignal | null => {
  const coreMissing: string[] = [];
  if (!input.payload.title) coreMissing.push("title");
  if (input.payload.basePrice == null) coreMissing.push("base_price");
  if (coreMissing.length === 0) return null;
  return {
    signalKind: "missing_required_attribute",
    severity: "high",
    fieldName: coreMissing[0]!,
    clusterDimensions: { domain: input.domain, category: input.category.path ?? "" },
    payload: {
      evidence: { missing: coreMissing, category: input.category.path },
      reasonText: `Missing required: ${coreMissing.join(", ")}`,
      affectedFields: coreMissing,
    },
  };
};
