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
 *
 * Phase 2 thresholds (embedding component is stubbed — see map.ts step 4).
 * The HLD-spec threshold is 0.92 for warning-free, but with embedding=0 the
 * maximum attainable score from channel+synonym+all-compat is 0.85. Until
 * pgvector lands the warning-free band would be empty.
 *
 *   ≥ 0.85 → auto-approved, mapping_method='auto'                (Phase 3: restore to 0.92)
 *   0.78 – 0.85 → approved with warning flag                     (Phase 3: 0.80 – 0.92)
 *   0.60 – 0.78 → suggestion (top-3 candidates in mapping_candidates)
 *   < 0.60 → unmapped → merchant_extensions_json or review queue
 */
const NO_WARNING_THRESHOLD = 0.85;
const WARNING_THRESHOLD = 0.78;
const SUGGESTION_THRESHOLD = 0.60;

export function resolveApproval(score: number): {
  approved: boolean;
  mappingMethod: string;
  warning: boolean;
} {
  if (score >= NO_WARNING_THRESHOLD) return { approved: true, mappingMethod: "auto", warning: false };
  if (score >= WARNING_THRESHOLD) return { approved: true, mappingMethod: "auto", warning: true };
  if (score >= SUGGESTION_THRESHOLD) return { approved: false, mappingMethod: "suggestion", warning: false };
  return { approved: false, mappingMethod: "unmapped", warning: false };
}
