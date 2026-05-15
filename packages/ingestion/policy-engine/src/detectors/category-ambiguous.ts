import type { Detector, ReviewTaskSignal, RouterInput } from "../types.js";

const THRESHOLD = 0.70;

export const detectCategoryAmbiguous: Detector = (input: RouterInput): ReviewTaskSignal | null => {
  if (input.category.path && input.category.confidence >= THRESHOLD) return null;
  return {
    signalKind: "category_ambiguous",
    severity: "medium",
    fieldName: "canonicalCategory",
    clusterDimensions: { domain: input.domain, category: input.category.path ?? "(none)" },
    payload: {
      evidence: { path: input.category.path, confidence: input.category.confidence },
      reasonText: input.category.path
        ? `Category confidence ${input.category.confidence.toFixed(2)} below ${THRESHOLD}`
        : "No category detected",
      affectedFields: ["canonicalCategory"],
    },
  };
};
