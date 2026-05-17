import type { AuditEmitter } from "@aonex/audit";
import type { StageAuditMeta, StageName } from "./types.js";

/**
 * Emit a single `ingestion.<stage>.completed` audit event with the standard
 * StageAuditMeta envelope. Extra stage-specific metadata is shallow-merged
 * into the event's `metadata` field.
 *
 * The entityId convention is artifactId when known, else the requestId — so
 * the duplicate path (no artifactId yet) still emits a traceable event.
 */
export async function emitStageAudit(
  audit: AuditEmitter,
  stage: StageName,
  meta: StageAuditMeta,
  extra?: Record<string, unknown>
): Promise<void> {
  await audit.emit({
    tenantId: meta.tenantId,
    merchantId: meta.merchantId,
    actorType: "worker",
    eventType: `ingestion.${stage}.completed`,
    entityType: "ingestion_run",
    entityId: meta.artifactId ?? meta.requestId,
    requestId: meta.requestId,
    traceId: meta.traceId,
    metadata: {
      stage,
      lane: meta.lane,
      extractorVersion: meta.extractorVersion,
      mapperVersion: meta.mapperVersion,
      policyVersion: meta.policyVersion,
      extractionRunId: meta.extractionRunId,
      factSetId: meta.factSetId,
      productId: meta.productId,
      productVersionId: meta.productVersionId,
      proposedDiffId: meta.proposedDiffId,
      ...extra
    }
  });
}
