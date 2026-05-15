import type { Detector, ReviewTaskSignal, RouterInput } from "../types.js";

export const detectIdentityConflict: Detector = (input: RouterInput): ReviewTaskSignal | null => {
  const conflicts: { type: "gtin" | "mpn"; existing: { productId: string; brand: string | null; canonicalCategory: string | null } }[] = [];

  if (input.payload.gtin && input.identityIndex.gtin) {
    const exist = input.identityIndex.gtin;
    if (norm(exist.brand) !== norm(input.payload.brand)) {
      conflicts.push({ type: "gtin", existing: exist });
    }
  }
  if (input.payload.modelNumber && input.identityIndex.mpn) {
    const exist = input.identityIndex.mpn;
    if (norm(exist.brand) !== norm(input.payload.brand)) {
      conflicts.push({ type: "mpn", existing: exist });
    }
  }
  if (conflicts.length === 0) return null;
  return {
    signalKind: "potential_duplicate",
    severity: "critical",
    fieldName: null,
    clusterDimensions: { domain: input.domain },
    payload: {
      evidence: { conflicts },
      reasonText: `Identity match to existing product with different brand`,
      affectedFields: ["brand", "gtin", "modelNumber"],
    },
  };
};

function norm(s: string | null): string {
  return (s ?? "").trim().toLowerCase();
}
