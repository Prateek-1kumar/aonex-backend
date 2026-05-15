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
    if (!f.sourceAlternatives || f.sourceAlternatives.length === 0) continue;

    // Drop alts whose value equals the winner — different sources reporting
    // the same answer aren't a conflict. (merge.ts already does this; this is
    // a belt-and-braces guard for sources we'll add later that may not.)
    const realAlts = f.sourceAlternatives.filter((alt) => !sameValue(alt.value, f.extractedValue));
    if (realAlts.length === 0) continue;

    // Unit-aware skip: if this fact is a unit-aware measurement with a known
    // canonical unit and alts that convert to the same value, treat alternative
    // sources as compatible rather than firing a false conflict.
    const dim = UNIT_AWARE_FIELDS[f.rawKey];
    if (dim && typeof f.extractedValue === "number" && f.unit) {
      const winnerCanonical = convertToCanonical(f.extractedValue, f.unit, dim);
      if (winnerCanonical) {
        const allCompatible = realAlts.every((alt) => {
          if (typeof alt.value !== "number") return false;
          const altCanonical = convertToCanonical(alt.value, f.unit ?? "", dim);
          return !!altCanonical && Math.abs(altCanonical.value - winnerCanonical.value) < 1e-6;
        });
        if (allCompatible) continue;
      }
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
          ...realAlts.map((alt) => ({
            value: alt.value,
            source: alt.sourcePointer,
            confidence: alt.confidence,
          })),
        ],
      },
    };
  }
  return null;
};

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 1e-6;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
