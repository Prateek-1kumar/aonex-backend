// HLD §10.3 — confidence scorer weights for the semantic mapper pipeline.
// Weights are fixed per Phase 2; Phase 3+ reads them from policy_versions.scoring_weights.

/** HLD §10.3 — mapping confidence component weights */
export const MAPPING_WEIGHTS = {
  channelMapping: 0.40, // exact deterministic lookup
  synonym: 0.18,        // synonym table match
  embedding: 0.15,      // pgvector cosine (Phase 3, stubbed)
  typeCompat: 0.10,     // data_type compatibility
  unitCompat: 0.07,     // unit compatibility
  categoryCompat: 0.06, // attribute is in-scope for category
  tenantCorrection: 0.04 // tenant override applied
} as const;

export interface CandidateScore {
  key: string;
  channelMapping: number;
  synonym: number;
  embedding: number;
  typeCompat: number;
  unitCompat: number;
  categoryCompat: number;
  tenantCorrection: number;
  total: number;
}

export function computeScore(components: Omit<CandidateScore, "total">): CandidateScore {
  const total =
    components.channelMapping * MAPPING_WEIGHTS.channelMapping +
    components.synonym * MAPPING_WEIGHTS.synonym +
    components.embedding * MAPPING_WEIGHTS.embedding +
    components.typeCompat * MAPPING_WEIGHTS.typeCompat +
    components.unitCompat * MAPPING_WEIGHTS.unitCompat +
    components.categoryCompat * MAPPING_WEIGHTS.categoryCompat +
    components.tenantCorrection * MAPPING_WEIGHTS.tenantCorrection;

  return { ...components, total: Math.min(1.0, total) };
}

/**
 * HLD §10.4 — decision thresholds for mapping approval.
 * ≥ 0.92 → auto-approved, mapping_method='auto'
 * 0.80 – 0.92 → approved with warning flag
 * 0.60 – 0.80 → suggestion (top-3 candidates in mapping_candidates)
 * < 0.60 → unmapped → merchant_extensions_json or review queue
 */
export function resolveApproval(score: number): {
  approved: boolean;
  mappingMethod: string;
  warning: boolean;
} {
  if (score >= 0.92) return { approved: true, mappingMethod: "auto", warning: false };
  if (score >= 0.80) return { approved: true, mappingMethod: "auto", warning: true };
  if (score >= 0.60) return { approved: false, mappingMethod: "suggestion", warning: false };
  return { approved: false, mappingMethod: "unmapped", warning: false };
}
