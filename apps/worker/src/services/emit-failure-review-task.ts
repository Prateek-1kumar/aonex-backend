// Surfaces ingestion-time failures (HTTP block, captcha wall, no-data, duplicate
// artifact) into review_tasks so the Anomaly Lab UI shows them instead of
// dropping them silently. Runs at points in link-extract.processor.ts that
// return BEFORE persistLinkCatalogPipeline creates a proposed_diff — hence the
// nullable proposed_diff_id (migration 0003).

import { schema, type DrizzleClient } from "@aonex/db";
import { clusterKey } from "@aonex/ingestion-policy-engine";
import type { DetectorSeverity, ReviewTaskSignal, SignalKind } from "@aonex/ingestion-policy-engine";
import { domainOf } from "@aonex/lib-utils";
import type { ArtifactId, MerchantId, TenantId } from "@aonex/types";

export type FailureSignalKind =
  | "fetch_failed"
  | "captcha_wall"
  | "no_data_extracted"
  | "artifact_duplicate";

export interface EmitFailureReviewTaskInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  artifactId: ArtifactId | null;
  signalKind: FailureSignalKind;
  url: string;
  reasonText: string;
  evidence: Record<string, unknown>;
}

const SEVERITY: Record<FailureSignalKind, DetectorSeverity> = {
  fetch_failed: "high",
  captcha_wall: "high",
  no_data_extracted: "high",
  artifact_duplicate: "low",
};

export async function emitFailureReviewTask(input: EmitFailureReviewTaskInput): Promise<void> {
  const domain = domainOf(input.url);
  const severity = SEVERITY[input.signalKind];

  // Reuse the same clusterKey hash as detector signals so the Anomaly Lab
  // groups failures of the same kind per-domain (e.g. all Croma 403s cluster).
  const fakeSignal: ReviewTaskSignal = {
    signalKind: input.signalKind as SignalKind,
    severity,
    fieldName: null,
    clusterDimensions: { domain },
    payload: {
      evidence: input.evidence,
      reasonText: input.reasonText,
      affectedFields: [],
    },
  };

  await input.db.insert(schema.reviewTasks).values({
    tenantId: input.tenantId,
    merchantId: input.merchantId,
    proposedDiffId: null,
    artifactId: input.artifactId,
    taskType: input.signalKind, // dual-write to legacy column
    signalKind: input.signalKind,
    signalPayload: {
      url: input.url,
      domain,
      reasonText: input.reasonText,
      evidence: input.evidence,
    },
    clusterKey: clusterKey(fakeSignal),
    fieldName: null,
    severity,
    policyVersionId: null,
  });
}
