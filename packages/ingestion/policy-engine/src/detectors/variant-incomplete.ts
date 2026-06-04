// Policy-engine detector — incomplete variant matrix.
//
// detectVariantIncomplete fires when the actual variant count falls short of
// the cross-product of input.variantAxes (e.g. size × color), signalling a
// gappy matrix. One rule in the router.ts array; emits a `variant_incomplete`
// ReviewTaskSignal.

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
