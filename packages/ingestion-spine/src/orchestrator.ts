// The ingestion spine — runIngestion drives one envelope through every stage.
//
// Spec §5.2: persist_artifact → extract → map → validate → score → diff →
// (approve | review), emitting one audit event per stage and returning an
// approved / review / duplicate / validation_failed result. Owns the
// extraction_run / fact_set / facts persistence and artifact-status updates;
// lane-specific work lives behind the IngestionAdapter passed in.

import { schema, type DrizzleClient } from "@aonex/db";
import { eq } from "drizzle-orm";
import type { AuditEmitter } from "@aonex/audit";
import type { TenantId, MerchantId } from "@aonex/types";
import type { IngestionAdapter, IngestionEnvelope } from "./adapter.js";
import type { StageAuditMeta } from "./types.js";
import { persistArtifact } from "./stages/persist-artifact.js";
import { runExtract } from "./stages/extract.js";
import { runMap } from "./stages/map.js";
import { runValidate } from "./stages/validate.js";
import { runScore } from "./stages/score.js";
import { runDiff } from "./stages/diff.js";
import { runApprove } from "./stages/approve.js";
import { persistDiffFields } from "./stages/persist-diff-fields.js";
import { emitStageAudit } from "./audit-helpers.js";
import { MAPPER_VERSION } from "@aonex/ingestion-semantic-mapper";
import { clusterKey } from "@aonex/ingestion-policy-engine";
import { domainOf } from "@aonex/lib-utils";
import type { ExtractedFact, ExtractedFactSet } from "@aonex/ingestion-field-extractor";

/** Minimal view of the canonical skuJson the spine reads core fields from.
 *  (Full type is SkuJson in @aonex/ingestion-enrichment; inlined to avoid a
 *  package dependency for a read-only projection.) */
interface SkuJsonCore {
  title?: string | null;
  brand?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  model_number?: string | null;
  description_long?: string | null;
  description_short?: string | null;
  category_path?: string | null;
  images?: unknown;
  pricing?: { list_price?: number | null; sale_price?: number | null; currency?: string | null } | null;
}

/** Signals handed to the injected taxonomy classifier. */
export interface SpineCategorySignals {
  title?: string;
  brand?: string;
  /** Raw/free-text category from extraction (mapped.categoryPath). */
  sourceCategory?: string;
}

/** What the classifier returns — mirrors @aonex/taxonomy-classifier's
 *  FallbackResult, narrowed to what the spine needs. */
export interface SpineCategoryResult {
  nodeId: string | null;
  confidence: number;
  outcome: "assign" | "propose_node" | "abstain";
}

/**
 * Injected taxonomy classifier. The worker owns the (cached) taxonomy index +
 * LLM resolver and supplies this closure so the spine package stays free of the
 * classifier/DB-index-loading concern and stays trivially testable. When
 * omitted (unit tests / lanes without taxonomy) category resolution is skipped
 * and category confidence stays 0 — preserving prior behavior.
 */
export type SpineCategoryClassifier = (
  signals: SpineCategorySignals
) => Promise<SpineCategoryResult>;

export interface RunIngestionInput {
  db: DrizzleClient;
  audit: AuditEmitter;
  adapter: IngestionAdapter;
  envelope: IngestionEnvelope;
  tenantId: TenantId;
  merchantId: MerchantId;
  requestId: string;
  traceId: string;
  /** Optional: resolve a canonical taxonomy node at ingestion (see type doc). */
  classifyCategory?: SpineCategoryClassifier;
}

// Post-extraction results carry `artifactId` + `skuJson` so the worker can run
// the canonical catalog write (`runNewLinkCatalogPath` → `admitOrStage`). The
// spine package MUST NOT depend on @aonex/catalog-service (layering), so it
// only surfaces the already-extracted SkuJson (the rich canonical object the
// link-adapter built) and the artifact id; the worker-side wrapper
// (`runSpineLink`) performs the write. The "duplicate" path omits both because
// extraction never ran. Fields are inlined (not a shared intersection type) so
// the inferred return types of worker functions stay portable (avoids TS2742).
export type RunIngestionResult =
  | {
      status: "approved";
      productId: string;
      productVersionId: string;
      confidenceScore: number;
      artifactId?: string;
      skuJson?: unknown;
      /** Canonical taxonomy node resolved at ingestion (null = unresolved). */
      categoryNodeId?: string | null;
    }
  | {
      status: "review";
      proposedDiffId: string;
      reasons: string[];
      confidenceScore: number;
      artifactId?: string;
      skuJson?: unknown;
      categoryNodeId?: string | null;
    }
  | { status: "duplicate"; checksum: string }
  | {
      status: "validation_failed";
      missingRequired: string[];
      reasons: string[];
      artifactId?: string;
      skuJson?: unknown;
      categoryNodeId?: string | null;
    };

/**
 * Spec §5.2 — unified ingestion spine. Drives every lane (link / csv /
 * marketplace) through the same persist → extract → map → validate → score
 * → diff → (approve | review) sequence, emitting one audit event per stage.
 *
 * Legacy parity (preserved from apps/worker/src/services/link-catalog-pipeline.ts):
 *   1. Per-signal review_tasks rows on the review path (dual-write to legacy
 *      task_type column + new signal_kind/cluster_key fields).
 *   2. Per-field proposed_diff_fields rows on first diff insertion only.
 *   3. Title-presence gate on auto-approve (no title → never auto-approve).
 *   4. categoryRequiredAttributes threaded into the policy router from the
 *      validate stage's resolved schema row.
 */
export async function runIngestion(input: RunIngestionInput): Promise<RunIngestionResult> {
  const meta: StageAuditMeta = {
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    artifactId: null,
    extractionRunId: null,
    factSetId: null,
    productId: null,
    productVersionId: null,
    proposedDiffId: null,
    requestId: input.requestId,
    traceId: input.traceId,
    lane: input.adapter.lane,
    // Overwritten with the real version after the extract stage runs.
    extractorVersion: "spine-1",
    mapperVersion: MAPPER_VERSION,
    policyVersion: "v1"
  };

  // 1. persist_artifact
  const persisted = await persistArtifact({
    db: input.db,
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    envelope: input.envelope
  });
  if (!persisted.artifactId) {
    await emitStageAudit(input.audit, "persist_artifact", meta, {
      duplicate: true,
      checksum: persisted.duplicateOfChecksum
    });
    return { status: "duplicate", checksum: persisted.duplicateOfChecksum ?? input.envelope.checksum };
  }
  meta.artifactId = persisted.artifactId;
  await emitStageAudit(input.audit, "persist_artifact", meta);

  // 2. extract
  const factSet = await runExtract({
    adapter: input.adapter,
    envelope: input.envelope,
    artifactId: persisted.artifactId
  });
  meta.extractorVersion = factSet.extractorVersion;
  await emitStageAudit(input.audit, "extract", meta, { factsCount: factSet.facts.length });

  // 3. map
  const mapped = await runMap({
    db: input.db,
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    factSet,
    categoryHint: input.envelope.extractionHints?.categoryHint ?? null
  });
  await emitStageAudit(input.audit, "map", meta, { mapperVersion: mapped.mapperVersion });

  // 4. validate
  const validateResult = await runValidate({ db: input.db, mappedFactSet: mapped });
  await emitStageAudit(input.audit, "validate", meta, {
    valid: validateResult.valid,
    tier: validateResult.tier,
    missingRequired: validateResult.missingRequired
  });
  if (!validateResult.valid && validateResult.tier === "authoritative") {
    await updateArtifactStatus(input.db, persisted.artifactId, "failed");
    return {
      status: "validation_failed",
      missingRequired: validateResult.missingRequired,
      reasons: validateResult.errors.map((e) => `${e.path}: ${e.message}`),
      artifactId: persisted.artifactId,
      skuJson: factSet.skuJson
    };
  }

  // Canonical core fields from the extracted skuJson. The semantic mapper only
  // assigns canonicalPath to category ATTRIBUTES, so title/brand/price/category
  // never reach validateResult.attributes (every fact's canonicalPath is null).
  // Reading core fields from there yields null and makes missing_required +
  // the title gate fire on EVERY product. The skuJson is the canonical source.
  const sku = (factSet.skuJson ?? null) as SkuJsonCore | null;
  const coreFields = {
    title: sku?.title ?? null,
    brand: sku?.brand ?? null,
    gtin: sku?.gtin ?? null,
    modelNumber: sku?.model_number ?? sku?.mpn ?? null,
    basePrice: sku?.pricing?.list_price ?? sku?.pricing?.sale_price ?? null,
    currency: sku?.pricing?.currency ?? null,
    canonicalCategory: sku?.category_path ?? mapped.categoryPath ?? null
  };

  // 4b. classify — resolve a canonical taxonomy node at ingestion so the
  // product is enrich-ready and so category confidence (below) reflects a real
  // classification instead of a hardcoded 0. Only a confident `assign` yields a
  // node + non-zero confidence; `propose_node`/`abstain` leave the product
  // unresolved (confidence 0 → category_ambiguous trips → the "hard" cases the
  // Review Queue surfaces). No classifier injected → behavior unchanged.
  let categoryNodeId: string | null = null;
  let categoryConfidence = 0;
  if (input.classifyCategory) {
    const c = await input.classifyCategory({
      ...(coreFields.title ? { title: coreFields.title } : {}),
      ...(coreFields.brand ? { brand: coreFields.brand } : {}),
      ...(coreFields.canonicalCategory ? { sourceCategory: coreFields.canonicalCategory } : {})
    });
    if (c.outcome === "assign" && c.nodeId) {
      categoryNodeId = c.nodeId;
      categoryConfidence = c.confidence;
      // When extraction yielded no free-text category, use the resolved node as
      // the canonical category so the policy's category detector sees a category
      // (path + confidence) and doesn't flag `category_ambiguous` on a product
      // we DID confidently classify. Mirrors the catalog-write category bridge.
      if (!coreFields.canonicalCategory) {
        coreFields.canonicalCategory = categoryNodeId;
      }
    }
    await emitStageAudit(input.audit, "classify", meta, {
      categoryNodeId,
      categoryConfidence,
      outcome: c.outcome
    });
  }

  // 5. score — also need active policy for downstream detectors.
  const policyRow = await ensureActivePolicy(input.db);
  // TODO(phase-3): load domain_profiles row and pass sourceReliability to runScore.
  // The detector that consumes it (source-reliability) isn't wired yet.

  const decision = await runScore({
    db: input.db,
    tenantId: input.tenantId,
    mappedFactSet: mapped,
    attributes: validateResult.attributes,
    coreFields,
    // Real classification confidence from the classify stage (0 when no
    // classifier is injected or the classifier abstained).
    categoryConfidence,
    domain: domainOf(input.envelope.sourceExternalId),
    categoryRequiredAttributes: validateResult.requiredAttributes
  });
  await emitStageAudit(input.audit, "score", meta, {
    score: decision.score,
    route: decision.route,
    detectorsTripped: decision.evidence.detectorsTripped
  });

  // Persist extraction_run + fact_set + facts BEFORE diff so the diff row
  // can reference a real sourceFactSetId.
  meta.extractionRunId = await persistExtractionRun(input, persisted.artifactId, policyRow.id, factSet);
  meta.factSetId = await persistFactSet(input, persisted.artifactId, meta.extractionRunId);
  await persistFacts(input, meta.factSetId, mapped.facts);

  // Auto-approve requires a title — applyApprovedDiff throws on missing title,
  // so auto-approving without one would crash the worker (legacy parity). Read
  // from coreFields (skuJson), not validateResult.attributes (which never holds
  // core fields — see the coreFields note above).
  const titlePresent = Boolean(coreFields.title);
  const shouldAutoApprove = decision.route === "auto_approve" && titlePresent;

  // 6. diff
  const diff = await runDiff({
    db: input.db,
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    factSetId: meta.factSetId,
    policyVersionId: policyRow.id,
    confidenceScore: decision.score,
    status: shouldAutoApprove ? "auto_approved" : "open",
    payload: {
      ...validateResult.attributes,
      // Core fields come from the canonical skuJson (not validateResult.attributes,
      // which only holds category attributes) so applyApprovedDiff can build the
      // product on the auto-approve path instead of throwing on a null title.
      title: coreFields.title,
      brand: coreFields.brand,
      gtin: coreFields.gtin,
      modelNumber: coreFields.modelNumber,
      basePrice: coreFields.basePrice,
      currency: coreFields.currency,
      description: sku?.description_long ?? sku?.description_short ?? null,
      images: Array.isArray(sku?.images) ? sku.images : [],
      attributes: validateResult.attributes,
      canonicalCategory: coreFields.canonicalCategory,
      categoryNodeId,
      categorySchemaVersion: validateResult.categorySchemaVersion,
      categoryConfidence,
      evidence: decision.evidence
    }
  });
  meta.proposedDiffId = diff.diffId;
  await emitStageAudit(input.audit, "diff", meta, { created: diff.created });

  // Idempotency: the diff already existed (retry path). Skip re-inserting
  // per-field rows and review_tasks (they were written on the first run).
  // We still call runApprove on the auto-approve branch to fetch the
  // product/version IDs the legacy callers depend on — it's a cheap lookup
  // thanks to applyApprovedDiff's existingVersion early-return.
  if (!diff.created) {
    if (shouldAutoApprove) {
      const approved = await runApprove({ db: input.db, diffId: diff.diffId });
      meta.productId = approved.productId;
      meta.productVersionId = approved.productVersionId;
      await emitStageAudit(input.audit, "approve", meta, { idempotent: true });
      return {
        status: "approved",
        productId: approved.productId,
        productVersionId: approved.productVersionId,
        confidenceScore: decision.score,
        artifactId: persisted.artifactId,
        skuJson: factSet.skuJson,
        categoryNodeId
      };
    }
    return {
      status: "review",
      proposedDiffId: diff.diffId,
      reasons: decision.reviewTasks.map((t) => t.signalKind),
      confidenceScore: decision.score,
      artifactId: persisted.artifactId,
      skuJson: factSet.skuJson,
      categoryNodeId
    };
  }

  // After this point we know diff was newly created.

  // Per-field detail rows for the reviewer UI.
  await persistDiffFields({
    db: input.db,
    diffId: diff.diffId,
    payload: {
      ...validateResult.attributes,
      title: coreFields.title,
      brand: coreFields.brand,
      basePrice: coreFields.basePrice,
      currency: coreFields.currency,
      canonicalCategory: coreFields.canonicalCategory,
      attributes: validateResult.attributes
    },
    facts: mapped.facts
  });

  // 7. approve OR review
  if (shouldAutoApprove) {
    const approved = await runApprove({ db: input.db, diffId: diff.diffId });
    meta.productId = approved.productId;
    meta.productVersionId = approved.productVersionId;
    await emitStageAudit(input.audit, "approve", meta);
    await updateArtifactStatus(input.db, persisted.artifactId, "completed");
    return {
      status: "approved",
      productId: approved.productId,
      productVersionId: approved.productVersionId,
      confidenceScore: decision.score,
      artifactId: persisted.artifactId,
      skuJson: factSet.skuJson,
      categoryNodeId
    };
  }

  // Review path — write review_tasks rows for each detector signal (legacy
  // parity). Guarded by the early-return above, so these are always new rows.
  for (const signal of decision.reviewTasks) {
    await input.db.insert(schema.reviewTasks).values({
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      proposedDiffId: diff.diffId,
      artifactId: persisted.artifactId,
      // TODO(phase-3): drop taskType once readers migrate to signal_kind
      taskType: signal.signalKind,            // dual-write
      signalKind: signal.signalKind,
      signalPayload: signal.payload as Record<string, unknown>,
      clusterKey: clusterKey(signal),
      fieldName: signal.fieldName ?? null,
      severity: signal.severity,
      policyVersionId: policyRow.id
    });
  }

  await updateArtifactStatus(input.db, persisted.artifactId, "needs_review");
  return {
    status: "review",
    proposedDiffId: diff.diffId,
    reasons: decision.reviewTasks.map((t) => t.signalKind),
    confidenceScore: decision.score,
    artifactId: persisted.artifactId,
    skuJson: factSet.skuJson,
    categoryNodeId
  };
}

/**
 * Update source_artifacts.status at the end of the run.
 * Mirrors legacy link-extract.processor.ts behavior so the recent-ingestions
 * UI no longer shows every spine ingestion as "processing" indefinitely.
 *
 * Failure here is non-fatal — log via the caller's audit channel later when
 * we wire that in. For now, errors are swallowed because the source_artifact
 * already has the correct ingestion data; the status field is just a hint.
 */
async function updateArtifactStatus(
  db: DrizzleClient,
  artifactId: string,
  status: "completed" | "needs_review" | "failed"
): Promise<void> {
  try {
    await db
      .update(schema.sourceArtifacts)
      .set({ status })
      .where(eq(schema.sourceArtifacts.id, artifactId));
  } catch {
    // Non-fatal: status is observational.
  }
}

// ---------------------------------------------------------------------------
// Helpers — extraction_run / fact_set / facts persistence (mirrors legacy)
// ---------------------------------------------------------------------------

async function ensureActivePolicy(db: DrizzleClient) {
  const active = await db.query.policyVersions.findFirst({
    where: (p, { eq }) => eq(p.active, true)
  });
  if (active) return active;
  throw new Error("No active policy_version configured");
}

async function persistExtractionRun(
  input: RunIngestionInput,
  artifactId: string,
  policyVersionId: string,
  factSet: ExtractedFactSet
): Promise<string> {
  const [row] = await input.db
    .insert(schema.linkIngestionTraceRuns)
    .values({
      artifactId,
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      extractorVersion: factSet.extractorVersion,
      mapperVersion: MAPPER_VERSION,
      policyVersionId,
      status: "succeeded",
      startedAt: factSet.extractedAt,
      completedAt: new Date()
    })
    .onConflictDoNothing()
    .returning({ id: schema.linkIngestionTraceRuns.id });
  if (row) return row.id;

  const existing = await input.db.query.linkIngestionTraceRuns.findFirst({
    where: (r, { and, eq }) =>
      and(
        eq(r.artifactId, artifactId),
        eq(r.extractorVersion, factSet.extractorVersion),
        eq(r.mapperVersion, MAPPER_VERSION),
        eq(r.policyVersionId, policyVersionId)
      )
  });
  if (!existing) throw new Error("Failed to persist extraction_run");
  return existing.id;
}

async function persistFactSet(
  input: RunIngestionInput,
  artifactId: string,
  extractionRunId: string
): Promise<string> {
  const existing = await input.db.query.linkIngestionTraceSets.findFirst({
    where: (fs, { eq }) => eq(fs.extractionRunId, extractionRunId)
  });
  if (existing) return existing.id;

  const [row] = await input.db
    .insert(schema.linkIngestionTraceSets)
    .values({
      extractionRunId,
      artifactId,
      tenantId: input.tenantId,
      merchantId: input.merchantId
    })
    .returning({ id: schema.linkIngestionTraceSets.id });
  if (!row) throw new Error("Failed to persist fact_set");
  return row.id;
}

async function persistFacts(
  input: RunIngestionInput,
  factSetId: string,
  facts: ReadonlyArray<ExtractedFact>
): Promise<void> {
  if (facts.length === 0) return;
  const existing = await input.db.query.linkIngestionTraceFacts.findFirst({
    where: (f, { eq }) => eq(f.factSetId, factSetId)
  });
  if (existing) return;
  await input.db.insert(schema.linkIngestionTraceFacts).values(
    facts.map((f) => ({
      factSetId,
      tenantId: input.tenantId,
      rawKey: f.rawKey,
      canonicalPath: f.canonicalPath,
      extractedValue: f.extractedValue,
      normalizedValue: f.normalizedValue,
      unit: f.unit,
      sourcePointer: f.sourcePointer,
      extractionMethod: f.extractionMethod,
      confidence: String(Math.max(0, Math.min(1, f.confidence))),
      mappingMethod: f.mappingMethod,
      mappingCandidates: f.mappingCandidates,
      sourceAlternatives: f.sourceAlternatives,
      approved: f.approved
    }))
  );
}
