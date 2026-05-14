import type { Detector, ReviewTaskSignal, RouterInput } from "../types.js";

const MEASUREMENT_HINTS = [
  /capacity/, /size_(?:cm|in|mm)/, /weight/, /length/, /height/, /width/, /depth/,
  /screen_size/, /volume/, /wattage/, /voltage/,
];

const NON_MEASUREMENT_AXES = /^variants\[\d+\]\.option\./;

export const detectUnitAmbiguity: Detector = (input: RouterInput): ReviewTaskSignal | null => {
  const offenders = input.facts.filter((f) => {
    if (NON_MEASUREMENT_AXES.test(f.rawKey)) return false;
    if (f.unit) return false;
    if (typeof f.extractedValue !== "number") return false;
    return MEASUREMENT_HINTS.some((r) => r.test(f.rawKey));
  });
  if (offenders.length === 0) return null;
  return {
    signalKind: "unit_conflict",
    severity: "medium",
    fieldName: offenders[0]!.rawKey,
    clusterDimensions: { domain: input.domain, field: offenders[0]!.rawKey },
    payload: {
      evidence: { fields: offenders.map((f) => ({ key: f.rawKey, value: f.extractedValue })) },
      reasonText: `${offenders.length} numeric field(s) have no unit`,
      affectedFields: offenders.map((f) => f.rawKey),
    },
  };
};
