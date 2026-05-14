import type { Detector, ReviewTaskSignal, RouterInput } from "../types.js";

const CONFLICT_FIELDS = ["title", "base_price", "currency", "brand"];

export const detectCrossSourceConflict: Detector = (input: RouterInput): ReviewTaskSignal | null => {
  for (const f of input.facts) {
    if (!CONFLICT_FIELDS.includes(f.rawKey)) continue;
    if (!f.mappingCandidates || f.mappingCandidates.length === 0) continue;
    return {
      signalKind: "field_conflict",
      severity: "high",
      fieldName: f.rawKey,
      clusterDimensions: { domain: input.domain, field: f.rawKey },
      payload: {
        evidence: { winner: { source: f.sourcePointer, value: f.extractedValue } },
        reasonText: `${f.rawKey} has conflicting values across sources`,
        affectedFields: [f.rawKey],
        candidates: [
          { value: f.extractedValue, source: f.sourcePointer, confidence: f.confidence },
          ...f.mappingCandidates.map((c) => ({
            value: c.key,
            source: c.key,
            confidence: c.score,
          })),
        ],
      },
    };
  }
  return null;
};
