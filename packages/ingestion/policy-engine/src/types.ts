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

// ───────────────────────────────────────────────────────────────────────
// Plan B — multi-signal router types. The legacy single-score `score()`
// in formula.ts is kept until Plan B Task 14 deletes it.
// ───────────────────────────────────────────────────────────────────────

import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

export type SignalKind =
  | "low_confidence_mapping"
  | "missing_required_attribute"
  | "field_conflict"
  | "unit_conflict"
  | "potential_duplicate"
  | "category_ambiguous"
  | "variant_incomplete"
  | "price_anomaly";

export type DetectorSeverity = "low" | "medium" | "high" | "critical";

export interface ReviewTaskSignal {
  signalKind: SignalKind;
  severity: DetectorSeverity;
  fieldName: string | null;
  clusterDimensions: Record<string, string>;
  payload: {
    evidence: Record<string, unknown>;
    reasonText: string;
    affectedFields: string[];
    candidates?: { value: unknown; source: string; confidence: number }[];
  };
}

export interface CanonicalPayloadSummary {
  title: string | null;
  brand: string | null;
  gtin: string | null;
  modelNumber: string | null;
  basePrice: number | null;
  currency: string | null;
  canonicalCategory: string | null;
  variants: Array<{ optionValues: Record<string, string>; sku: string | null; price: number | null }>;
}

export interface RouterInput {
  facts: ExtractedFact[];
  payload: CanonicalPayloadSummary;
  domain: string;
  category: { path: string | null; confidence: number };
  categoryRequiredAttributes: string[];
  identityIndex: {
    gtin?: { productId: string; brand: string | null; canonicalCategory: string | null };
    mpn?: { productId: string; brand: string | null; canonicalCategory: string | null };
  };
  priceCluster: { medianPrice: number; sampleCount: number } | null;
  variantAxes: Record<string, string[]>;
}

export interface RoutingDecision {
  route: "auto_approve" | "review";
  reviewTasks: ReviewTaskSignal[];
  score: number;
  evidence: {
    detectorsRun: SignalKind[];
    detectorsTripped: SignalKind[];
  };
}

export type Detector = (input: RouterInput) => ReviewTaskSignal | null;
