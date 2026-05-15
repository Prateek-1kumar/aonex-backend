import { convertToCanonical, type Dimension } from "@aonex/lib-utils";
import type { Detector, ReviewTaskSignal, RouterInput } from "../types.js";

const FIELD_DIMENSIONS: Record<string, Dimension> = {
  chest_inches: "length",
  screen_size: "length",
  weight: "mass",
  weight_kg: "mass",
  weight_grams: "mass",
  volume: "volume",
  battery_capacity: "energy",
  wattage: "power",
  voltage: "power",
  refresh_rate: "frequency",
};

// Pre-existing field-name hints kept so that legacy raw keys still trigger ambiguity even
// when not in FIELD_DIMENSIONS — preserves the Plan B Task 5 behaviour.
const MEASUREMENT_HINTS = [
  /capacity/, /size_(?:cm|in|mm)/, /weight/, /length/, /height/, /width/, /depth/,
  /screen_size/, /volume/, /wattage/, /voltage/,
];

const NON_MEASUREMENT_AXES = /^variants\[\d+\]\.option\./;

export const detectUnitAmbiguity: Detector = (input: RouterInput): ReviewTaskSignal | null => {
  const offenders = input.facts.filter((f) => {
    if (NON_MEASUREMENT_AXES.test(f.rawKey)) return false;
    if (typeof f.extractedValue !== "number") return false;

    const dim = FIELD_DIMENSIONS[f.rawKey];

    if (dim) {
      // Known dimension: fire only if the unit is missing OR unconvertible.
      if (!f.unit) return true;
      const converted = convertToCanonical(f.extractedValue, f.unit, dim);
      return converted == null;
    }

    // Unknown dimension: fall back to the legacy heuristic.
    // Fire only when the unit is missing AND the rawKey looks like a measurement.
    if (f.unit) return false;
    return MEASUREMENT_HINTS.some((r) => r.test(f.rawKey));
  });

  if (offenders.length === 0) return null;
  return {
    signalKind: "unit_conflict",
    severity: "medium",
    fieldName: offenders[0]!.rawKey,
    clusterDimensions: { domain: input.domain, field: offenders[0]!.rawKey },
    payload: {
      evidence: { fields: offenders.map((f) => ({ key: f.rawKey, value: f.extractedValue, unit: f.unit })) },
      reasonText: `${offenders.length} measurement(s) have ambiguous or unconvertible units`,
      affectedFields: offenders.map((f) => f.rawKey),
    },
  };
};
