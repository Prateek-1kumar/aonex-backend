import type { Detector, ReviewTaskSignal, RouterInput } from "../types.js";

// Catches *value-level* contradictions that the field-level detectors miss:
// the canonical fields are individually fine but disagree with each other.
//
// Today this covers two unambiguous patterns:
//   1. Top-level `color` extracted, but it's not one of the variant axis
//      values — the colors disagree on the same product.
//   2. GTIN extracted, but its length isn't 8/12/13/14 digits — almost always
//      a model number or SKU misclassified as a GTIN.
//
// Both produce review tasks rather than silently writing wrong data.

const VALID_GTIN_LENGTHS = new Set([8, 12, 13, 14]);
const DIGITS_ONLY = /^\d+$/;

export const detectValueContradiction: Detector = (
  input: RouterInput
): ReviewTaskSignal | null => {
  const reasons: string[] = [];
  const affectedFields: string[] = [];
  const evidence: Record<string, unknown> = {};

  // 1. color vs. variantAxes.color
  const colorFact = input.facts.find((f) => f.rawKey === "color");
  const colorAxis = input.variantAxes.color ?? [];
  if (colorFact && colorAxis.length > 0) {
    const topColor = String(
      colorFact.normalizedValue ?? colorFact.extractedValue ?? ""
    )
      .toLowerCase()
      .trim();
    const variantColors = colorAxis.map((c) => c.toLowerCase().trim());
    if (topColor && !variantColors.includes(topColor)) {
      reasons.push(
        `Top-level color "${topColor}" not present in variant colors [${colorAxis.join(", ")}]`
      );
      affectedFields.push("color");
      evidence.color = { topLevel: topColor, variantValues: colorAxis };
    }
  }

  // 2. GTIN length / digit sanity
  const gtin = input.payload.gtin;
  if (gtin) {
    const trimmed = gtin.trim();
    const lengthOk = VALID_GTIN_LENGTHS.has(trimmed.length);
    const digitsOk = DIGITS_ONLY.test(trimmed);
    if (!lengthOk || !digitsOk) {
      reasons.push(
        `GTIN "${gtin}" is not a valid 8/12/13/14-digit code (len=${trimmed.length}, digitsOnly=${digitsOk})`
      );
      affectedFields.push("gtin");
      evidence.gtin = { value: gtin, length: trimmed.length, digitsOnly: digitsOk };
    }
  }

  if (reasons.length === 0) return null;

  return {
    signalKind: "value_contradiction",
    severity: "high",
    fieldName: affectedFields[0] ?? null,
    clusterDimensions: {
      domain: input.domain,
      field: affectedFields[0] ?? "",
    },
    payload: {
      evidence,
      reasonText: reasons.join("; "),
      affectedFields,
    },
  };
};
