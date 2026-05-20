import { schema, type DrizzleClient } from "@aonex/db";
import { map, MAPPER_VERSION } from "@aonex/ingestion-semantic-mapper";
import { route, clusterKey } from "@aonex/ingestion-policy-engine";
import type { PolicyInputs } from "@aonex/ingestion-policy-engine";
import { domainOf } from "@aonex/lib-utils";
import { applyApprovedDiff } from "@aonex/catalog-service";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";
import type { ArtifactId, MerchantId, TenantId } from "@aonex/types";

import {
  getOrCreateActivePolicy,
  loadMapperCorpus,
  loadRequiredAttributeKeys,
  persistExtractionRun,
  persistFactSet,
  persistFacts,
  createProposedDiff,
  persistProposedDiffFields,
} from "./catalog-persistence.js";
import {
  buildCanonicalPayload,
  buildRouterInput,
  withFallbackCanonicalPath,
  CORE_FIELD_MAP,
} from "./payload-builder.js";

export interface PersistLinkCatalogInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  artifactId: ArtifactId;
  sourceUrl: string;
  factSet: ExtractedFactSet;
  suggestedCategory: string | null;
  categoryConfidence: number;
  extractorMeta: {
    modelName: string | null;
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
  };
  /** Real dedup decision (no longer hardcoded). */
  dedupeDecision: PolicyInputs["dedupeDecision"];
  /** Per-domain reliability from domain_profiles (no longer hardcoded 0.65). */
  sourceReliability: number;
}

export interface PersistLinkCatalogResult {
  extractionRunId: string;
  factSetId: string;
  proposedDiffId: string | null;
  route: "auto_approve" | "review";
  confidenceScore: number;
  productId?: string;
  productVersionId?: string;
}

export async function persistLinkCatalogPipeline(
  input: PersistLinkCatalogInput
): Promise<PersistLinkCatalogResult> {
  const policy = await getOrCreateActivePolicy(input.db);
  const corpus = await loadMapperCorpus(input.db, input.tenantId, input.merchantId);
  const mappedFactSet = map(input.factSet, input.suggestedCategory, corpus);
  const canonicalFacts = mappedFactSet.facts.map(withFallbackCanonicalPath);

  const extractionRunId = await persistExtractionRun(input.db, { artifactId: input.artifactId, tenantId: input.tenantId, merchantId: input.merchantId, extractorVersion: input.factSet.extractorVersion, mapperVersion: MAPPER_VERSION, extractedAt: input.factSet.extractedAt }, policy.id);
  const factSetId = await persistFactSet(input.db, { extractionRunId, artifactId: input.artifactId, tenantId: input.tenantId, merchantId: input.merchantId });
  await persistFacts(input.db, input.tenantId, factSetId, canonicalFacts);

  const canonicalPayload = buildCanonicalPayload({
    facts: canonicalFacts,
    sourceUrl: input.sourceUrl,
    artifactId: input.artifactId,
    suggestedCategory: input.suggestedCategory,
    categoryConfidence: input.categoryConfidence,
    mapperVersion: MAPPER_VERSION,
    extractorVersion: input.factSet.extractorVersion,
    extractorMeta: input.extractorMeta,
  });

  const routerInput = await buildRouterInput({
    db: input.db,
    tenantId: input.tenantId,
    facts: canonicalFacts,
    payload: canonicalPayload,
    domain: domainOf(input.sourceUrl),
    category: { path: input.suggestedCategory, confidence: input.categoryConfidence },
    categoryRequiredAttributes: await loadRequiredAttributeKeys(input.db, input.suggestedCategory),
  });

  const decision = route(routerInput);

  const shouldAutoApprove = decision.route === "auto_approve" && Boolean(canonicalPayload.title);
  const proposedDiff = await createProposedDiff({
    db: input.db,
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    factSetId,
    policyVersionId: policy.id,
    confidenceScore: decision.score,
    status: shouldAutoApprove ? "auto_approved" : "open",
    payload: {
      ...canonicalPayload,
      policyEvidence: decision.evidence,
    },
  });

  if (!proposedDiff.created) {
    return {
      extractionRunId,
      factSetId,
      proposedDiffId: proposedDiff.id,
      route: shouldAutoApprove ? "auto_approve" : "review",
      confidenceScore: decision.score,
    };
  }

  await persistProposedDiffFields({
    db: input.db,
    diffId: proposedDiff.id,
    payload: canonicalPayload,
    facts: canonicalFacts,
  });

  if (shouldAutoApprove) {
    const applied = await applyApprovedDiff({
      db: input.db,
      diffId: proposedDiff.id,
      approvalStatus: "auto_approved",
    });
    return {
      extractionRunId,
      factSetId,
      proposedDiffId: proposedDiff.id,
      route: "auto_approve",
      confidenceScore: decision.score,
      productId: applied.productId,
      productVersionId: applied.productVersionId,
    };
  }

  for (const signal of decision.reviewTasks) {
    await input.db.insert(schema.reviewTasks).values({
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      proposedDiffId: proposedDiff.id,
      artifactId: input.artifactId,
      taskType: signal.signalKind,           // dual-write to legacy column
      signalKind: signal.signalKind,
      signalPayload: signal.payload as Record<string, unknown>,
      clusterKey: clusterKey(signal),
      fieldName: signal.fieldName ?? null,
      severity: signal.severity,
      policyVersionId: policy.id,
    });
  }

  return {
    extractionRunId,
    factSetId,
    proposedDiffId: proposedDiff.id,
    route: "review",
    confidenceScore: decision.score,
  };
}
