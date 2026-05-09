// HLD §14 / §20 — Policy Engine types.

import type { DedupeDecision } from "@aonex/ingestion-deduplicator";

export type PolicyRoute = "auto_approve" | "review" | "reject";

export interface PolicyScore {
  score: number;
  route: PolicyRoute;
  /** Per-component breakdown for audit trail */
  evidence: {
    identityScore: number;
    categoryScore: number;
    fieldMappingScore: number;
    variantScore: number;
    schemaScore: number;
    mediaScore: number;
    sourceReliability: number;
    penalties: PenaltyRecord[];
    finalScore: number;
  };
}

export interface PenaltyRecord {
  reason: string;
  amount: number;
}

/** Inputs the worker reads from DB and passes as pure data */
export interface PolicyInputs {
  extractedFactCount: number;
  mappedFactCount: number;
  requiredAttributeKeys: string[];
  mappedCanonicalPaths: string[];
  hasGtin: boolean;
  hasBrand: boolean;
  hasMpn: boolean;
  categoryDetected: boolean;
  categoryConfidence: number;
  variantCount: number;
  imageCount: number;
  dedupeDecision: DedupeDecision;
  sourceReliability: number; // 0..1 — set by worker based on source type
  /** Units that could not be converted */
  unconvertibleUnits: string[];
  enumViolations: string[];
  variantInconsistencies: string[];
  llmOnlyCategory: boolean;
}

/** Policy thresholds read from policy_versions row */
export interface PolicyThresholds {
  autoApproveThreshold: number; // default 0.90
  anomalyThreshold: number;     // default 0.55
  rejectThreshold: number;      // default 0.55
}
