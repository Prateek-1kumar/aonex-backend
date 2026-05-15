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
 * Thresholds are calibrated against the actual reachable score ranges given
 * the Phase-2 weights above (embedding = 0, tenantCorrection often 0). With
 * those weights, max achievable score by signal type:
 *
 *   channel-mapping winner + perfect compats : 0.40 + 0.10 + 0.07 + 0.06 = 0.63
 *   synonym winner + perfect compats         : 0.18 + 0.10 + 0.07 + 0.06 = 0.41
 *   synonym winner + weak compats (no attr)  : 0.18 + 0.05 + 0.035 + 0.03 ≈ 0.30
 *
 *   ≥ 0.55 → auto-approved, mapping_method='auto'        (channel-mapping wins cleanly)
 *   0.40 – 0.55 → suggestion (synonym wins with good compats — needs human OK)
 *   0.25 – 0.40 → suggestion (synonym wins with weak compats — review)
 *   < 0.25 → unmapped → merchant_extensions_json or review queue
 *
 * Phase 3 (pgvector embedding live) will reintroduce higher thresholds.
 */
const NO_WARNING_THRESHOLD = 0.55;
const WARNING_THRESHOLD = 0.45;
export const SUGGESTION_THRESHOLD = 0.25;

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
