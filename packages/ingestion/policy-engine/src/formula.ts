// HLD §14.1 — confidence scoring formula + penalties.
// Pure function — read thresholds from policy_versions row, NOT from constants.

import type { PolicyInputs, PolicyRoute, PolicyScore, PenaltyRecord, PolicyThresholds } from "./types.js";

// HLD §14.1 component weights (fixed per spec — not configurable in Phase 2)
const W = {
  identity: 0.40,
  category: 0.15,
  fieldMapping: 0.15,
  variant: 0.10,
  schema: 0.10,
  media: 0.05,
  sourceReliability: 0.05
} as const;

export function score(inputs: PolicyInputs, thresholds: PolicyThresholds): PolicyScore {
  const identityScore = computeIdentityScore(inputs);
  const categoryScore = computeCategoryScore(inputs);
  const fieldMappingScore = computeFieldMappingScore(inputs);
  const variantScore = computeVariantScore(inputs);
  const schemaScore = computeSchemaScore(inputs);
  const mediaScore = computeMediaScore(inputs);
  const sourceReliability = Math.min(1.0, Math.max(0.0, inputs.sourceReliability));

  const rawScore =
    W.identity * identityScore +
    W.category * categoryScore +
    W.fieldMapping * fieldMappingScore +
    W.variant * variantScore +
    W.schema * schemaScore +
    W.media * mediaScore +
    W.sourceReliability * sourceReliability;

  const { finalScore, penalties } = applyPenalties(rawScore, inputs);

  const route = resolveRoute(finalScore, inputs, thresholds);

  return {
    score: finalScore,
    route,
    evidence: {
      identityScore,
      categoryScore,
      fieldMappingScore,
      variantScore,
      schemaScore,
      mediaScore,
      sourceReliability,
      penalties,
      finalScore
    }
  };
}

// -----------------------------------------------------------------
// Component sub-scores
// -----------------------------------------------------------------

function computeIdentityScore(inputs: PolicyInputs): number {
  let s = 0;
  if (inputs.hasGtin) s += 0.50;
  if (inputs.hasBrand) s += 0.30;
  if (inputs.hasMpn) s += 0.20;
  // Dedup result modifies identity confidence
  if (inputs.dedupeDecision.kind === "conflict") s *= 0.3;
  if (inputs.dedupeDecision.kind === "review") s *= 0.7;
  return Math.min(1.0, s);
}

function computeCategoryScore(inputs: PolicyInputs): number {
  if (!inputs.categoryDetected) return 0.0;
  return Math.min(1.0, inputs.categoryConfidence);
}

function computeFieldMappingScore(inputs: PolicyInputs): number {
  if (inputs.extractedFactCount === 0) return 0.0;
  // Average required-field confidence — approximated as ratio of mapped required fields
  const requiredMapped = inputs.requiredAttributeKeys.filter((k) =>
    inputs.mappedCanonicalPaths.includes(k)
  ).length;
  const requiredTotal = inputs.requiredAttributeKeys.length;
  if (requiredTotal === 0) return inputs.mappedFactCount / Math.max(1, inputs.extractedFactCount);
  return requiredMapped / requiredTotal;
}

function computeVariantScore(inputs: PolicyInputs): number {
  if (inputs.variantCount === 0) return 1.0; // no variants = no variant issues
  if (inputs.variantInconsistencies.length > 0) return 0.5;
  return 1.0;
}

function computeSchemaScore(inputs: PolicyInputs): number {
  if (inputs.requiredAttributeKeys.length === 0) return 1.0;
  const missingRequired = inputs.requiredAttributeKeys.filter(
    (k) => !inputs.mappedCanonicalPaths.includes(k)
  ).length;
  return Math.max(0, 1 - missingRequired / inputs.requiredAttributeKeys.length);
}

function computeMediaScore(inputs: PolicyInputs): number {
  if (inputs.imageCount === 0) return 0.0;
  if (inputs.imageCount >= 3) return 1.0;
  return inputs.imageCount / 3;
}

// -----------------------------------------------------------------
// Penalties — HLD §14.2
// -----------------------------------------------------------------

function applyPenalties(
  rawScore: number,
  inputs: PolicyInputs
): { finalScore: number; penalties: PenaltyRecord[] } {
  const penalties: PenaltyRecord[] = [];
  let penaltyTotal = 0;

  // Missing required category attribute: -0.10 each, cap -0.30
  const missingRequired = inputs.requiredAttributeKeys.filter(
    (k) => !inputs.mappedCanonicalPaths.includes(k)
  );
  const missingPenalty = Math.min(0.30, missingRequired.length * 0.10);
  if (missingPenalty > 0) {
    penaltyTotal += missingPenalty;
    penalties.push({ reason: `Missing required attributes: ${missingRequired.join(", ")}`, amount: missingPenalty });
  }

  // Unconvertible unit: -0.15 each (max 1 penalty applied)
  if (inputs.unconvertibleUnits.length > 0) {
    penaltyTotal += 0.15;
    penalties.push({ reason: `Unconvertible units: ${inputs.unconvertibleUnits.join(", ")}`, amount: 0.15 });
  }

  // Enum violation: -0.12 each (max 1 penalty applied)
  if (inputs.enumViolations.length > 0) {
    penaltyTotal += 0.12;
    penalties.push({ reason: `Enum violations: ${inputs.enumViolations.join(", ")}`, amount: 0.12 });
  }

  // Variant inconsistency: -0.15
  if (inputs.variantInconsistencies.length > 0) {
    penaltyTotal += 0.15;
    penalties.push({ reason: `Variant inconsistencies: ${inputs.variantInconsistencies.join(", ")}`, amount: 0.15 });
  }

  // Potential duplicate unconfirmed: -0.12
  if (inputs.dedupeDecision.kind === "review") {
    penaltyTotal += 0.12;
    penalties.push({ reason: "Potential duplicate — awaiting review", amount: 0.12 });
  }

  // LLM-only category: cap at 0.78 unless human-approved
  // (enforced after penalty calculation below)

  const finalScore = Math.max(0, Math.min(1.0, rawScore - penaltyTotal));

  // HLD §14.2: LLM-only category caps score at 0.78
  const capped = inputs.llmOnlyCategory ? Math.min(0.78, finalScore) : finalScore;
  if (inputs.llmOnlyCategory && finalScore > 0.78) {
    penalties.push({ reason: "LLM-only category: score capped at 0.78", amount: finalScore - 0.78 });
  }

  return { finalScore: capped, penalties };
}

// -----------------------------------------------------------------
// Routing
// -----------------------------------------------------------------

function resolveRoute(
  finalScore: number,
  inputs: PolicyInputs,
  thresholds: PolicyThresholds
): PolicyRoute {
  // Conflicts always go to review regardless of score
  if (inputs.dedupeDecision.kind === "conflict") return "review";
  if (finalScore >= thresholds.autoApproveThreshold) return "auto_approve";
  if (finalScore >= thresholds.rejectThreshold) return "review";
  return "reject";
}
