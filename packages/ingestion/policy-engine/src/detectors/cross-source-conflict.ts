import { convertToCanonical, type Dimension } from "@aonex/lib-utils";
import type { Detector, ReviewTaskSignal, RouterInput } from "../types.js";

const CONFLICT_FIELDS = ["title", "base_price", "currency", "brand", "chest_inches", "screen_size", "weight"];

const UNIT_AWARE_FIELDS: Record<string, Dimension> = {
  chest_inches: "length",
  weight_grams: "mass",
  weight_kg: "mass",
  screen_size: "length",
  battery_capacity: "energy",
  wattage: "power",
};

export const detectCrossSourceConflict: Detector = (input: RouterInput): ReviewTaskSignal | null => {
  for (const f of input.facts) {
    if (!CONFLICT_FIELDS.includes(f.rawKey)) continue;
    if (!f.mappingCandidates || f.mappingCandidates.length === 0) continue;

    // Unit-aware skip: if this fact is a unit-aware measurement with a known canonical
    // unit, we treat alternative sources as compatible rather than firing a false conflict.
    // Reason: merge.ts currently stores only source pointers (not alt values) in
    // mappingCandidates, so we cannot prove the alt value is genuinely different.
    const dim = UNIT_AWARE_FIELDS[f.rawKey];
    if (dim && typeof f.extractedValue === "number" && f.unit) {
      const canonical = convertToCanonical(f.extractedValue, f.unit, dim);
      if (canonical) continue; // skip firing — we have a convertible value
    }

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
          ...f.mappingCandidates.map((c) => ({ value: c.key, source: c.key, confidence: c.score })),
        ],
      },
    };
  }
  return null;
};
