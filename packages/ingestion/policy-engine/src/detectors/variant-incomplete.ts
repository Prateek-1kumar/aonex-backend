import type { Detector, ReviewTaskSignal, RouterInput } from "../types.js";

export const detectVariantIncomplete: Detector = (input: RouterInput): ReviewTaskSignal | null => {
  const axes = Object.values(input.variantAxes);
  if (axes.length === 0 || axes.some((v) => v.length === 0)) return null;
  const expected = axes.reduce((acc, vs) => acc * vs.length, 1);
  const actual = input.payload.variants.length;
  if (actual >= expected) return null;
  return {
    signalKind: "variant_incomplete",
    severity: "medium",
    fieldName: null,
    clusterDimensions: { domain: input.domain },
    payload: {
      evidence: { expected, actual, axes: input.variantAxes },
      reasonText: `Variants ${actual}/${expected} expected from axes cross-product`,
      affectedFields: ["variants"],
    },
  };
};
