import { schema, type DrizzleClient } from "@aonex/db";
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

export interface RunIngestionInput {
  db: DrizzleClient;
  audit: AuditEmitter;
  adapter: IngestionAdapter;
  envelope: IngestionEnvelope;
  tenantId: TenantId;
  merchantId: MerchantId;
  requestId: string;
  traceId: string;
}

export type RunIngestionResult =
  | { status: "approved"; productId: string; productVersionId: string; confidenceScore: number }
  | { status: "review"; proposedDiffId: string; reasons: string[]; confidenceScore: number }
  | { status: "duplicate"; checksum: string }
  | { status: "validation_failed"; missingRequired: string[]; reasons: string[] };

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
    return {
      status: "validation_failed",
      missingRequired: validateResult.missingRequired,
      reasons: validateResult.errors.map((e) => `${e.path}: ${e.message}`)
    };
  }

  // 5. score — also need active policy + domain profile for downstream
  // detectors and the audit trail.
  const policyRow = await ensureActivePolicy(input.db);
  const profile = await input.db.query.domainProfiles.findFirst({
    where: (p, { eq }) => eq(p.domainPattern, domainOf(input.envelope.sourceExternalId))
  });
  const sourceReliability =
    profile?.avgConfidence != null
      ? Math.max(0, Math.min(1, Number(profile.avgConfidence)))
      : 0.65;
  // Preserved for the audit trail; future detectors will consume it.
  void sourceReliability;

  const decision = await runScore({
    db: input.db,
    tenantId: input.tenantId,
    mappedFactSet: mapped,
    attributes: validateResult.attributes,
    categoryConfidence: 0.0,
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

  // Title-presence gate (legacy parity — no title → never auto-approve)
  const titlePresent = Boolean(validateResult.attributes.title);
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
      attributes: validateResult.attributes,
      canonicalCategory: mapped.categoryPath,
      categorySchemaVersion: validateResult.categorySchemaVersion,
      categoryConfidence: 0.0,
      evidence: decision.evidence
    }
  });
  meta.proposedDiffId = diff.diffId;
  await emitStageAudit(input.audit, "diff", meta, { created: diff.created });

  // Per-field detail — only when this diff was newly created (idempotency:
  // a retry hitting the unique index must not double-write field rows).
  if (diff.created) {
    await persistDiffFields({
      db: input.db,
      diffId: diff.diffId,
      payload: {
        ...validateResult.attributes,
        canonicalCategory: mapped.categoryPath,
        attributes: validateResult.attributes
      },
      facts: mapped.facts
    });
  }

  // 7. approve OR review
  if (shouldAutoApprove) {
    const approved = await runApprove({ db: input.db, diffId: diff.diffId });
    meta.productId = approved.productId;
    meta.productVersionId = approved.productVersionId;
    await emitStageAudit(input.audit, "approve", meta);
    return {
      status: "approved",
      productId: approved.productId,
      productVersionId: approved.productVersionId,
      confidenceScore: decision.score
    };
  }

  // Review path — write review_tasks rows for each detector signal (legacy
  // parity). Only on first insert so retries don't duplicate the cluster.
  if (diff.created) {
    for (const signal of decision.reviewTasks) {
      await input.db.insert(schema.reviewTasks).values({
        tenantId: input.tenantId,
        merchantId: input.merchantId,
        proposedDiffId: diff.diffId,
        artifactId: persisted.artifactId,
        taskType: signal.signalKind, // dual-write to legacy column
        signalKind: signal.signalKind,
        signalPayload: signal.payload as Record<string, unknown>,
        clusterKey: clusterKey(signal),
        fieldName: signal.fieldName ?? null,
        severity: signal.severity,
        policyVersionId: policyRow.id
      });
    }
  }

  return {
    status: "review",
    proposedDiffId: diff.diffId,
    reasons: decision.reviewTasks.map((t) => t.signalKind),
    confidenceScore: decision.score
  };
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
    .insert(schema.extractionRuns)
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
    .returning({ id: schema.extractionRuns.id });
  if (row) return row.id;

  const existing = await input.db.query.extractionRuns.findFirst({
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
  const existing = await input.db.query.extractedFactSets.findFirst({
    where: (fs, { eq }) => eq(fs.extractionRunId, extractionRunId)
  });
  if (existing) return existing.id;

  const [row] = await input.db
    .insert(schema.extractedFactSets)
    .values({
      extractionRunId,
      artifactId,
      tenantId: input.tenantId,
      merchantId: input.merchantId
    })
    .returning({ id: schema.extractedFactSets.id });
  if (!row) throw new Error("Failed to persist fact_set");
  return row.id;
}

async function persistFacts(
  input: RunIngestionInput,
  factSetId: string,
  facts: ReadonlyArray<ExtractedFact>
): Promise<void> {
  if (facts.length === 0) return;
  const existing = await input.db.query.extractedFacts.findFirst({
    where: (f, { eq }) => eq(f.factSetId, factSetId)
  });
  if (existing) return;
  await input.db.insert(schema.extractedFacts).values(
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
