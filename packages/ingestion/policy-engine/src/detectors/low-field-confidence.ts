// Policy-engine detector — low field confidence.
//
// detectLowFieldConfidence fires when any REQUIRED_FIELDS fact (title /
// base_price / currency) maps below THRESHOLD (0.70). One rule in the router.ts
// array; emits a `low_confidence_mapping` ReviewTaskSignal.

import type { Detector, ReviewTaskSignal, RouterInput } from "../types.js";

const REQUIRED_FIELDS = ["title", "base_price", "currency"];
const THRESHOLD = 0.70;

export const detectLowFieldConfidence: Detector = (input: RouterInput): ReviewTaskSignal | null => {
  const low = input.facts.filter(
    (f) => REQUIRED_FIELDS.includes(f.rawKey) && f.confidence < THRESHOLD
  );
  if (low.length === 0) return null;
  return {
    signalKind: "low_confidence_mapping",
    severity: "medium",
    fieldName: low[0]!.rawKey,
    clusterDimensions: { domain: input.domain, field: low[0]!.rawKey },
    payload: {
      evidence: { lowFields: low.map((f) => ({ key: f.rawKey, confidence: f.confidence })) },
      reasonText: `${low.length} required field(s) below confidence ${THRESHOLD}`,
      affectedFields: low.map((f) => f.rawKey),
    },
  };
};
