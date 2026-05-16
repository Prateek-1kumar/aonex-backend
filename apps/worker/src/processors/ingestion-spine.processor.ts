import type { Job } from "bullmq";
import type { DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import { runIngestion } from "@aonex/ingestion-spine";
import { createLinkAdapter } from "@aonex/link-adapter";
import { LLMProductExtractor } from "@aonex/ingestion-llm-extractor";
import type { TenantId, MerchantId } from "@aonex/types";

export interface IngestionSpineJobData {
  tenantId: TenantId;
  merchantId: MerchantId;
  lane: "link";    // CSV added in Phase 4
  sourceRef: string;
  categoryHint?: string;
  requestId: string;
  traceId: string;
}

export interface IngestionSpineProcessorDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
  llmExtractor: LLMProductExtractor;
}

/**
 * Inner function the legacy link-extract processor can call directly
 * via feature-flag dispatch, avoiding the need to synthesize a Job<>.
 */
export async function runSpineLink(
  deps: IngestionSpineProcessorDeps,
  data: IngestionSpineJobData
) {
  if (data.lane !== "link") {
    throw new Error(`Lane ${data.lane} not implemented in Phase 2`);
  }
  const adapter = createLinkAdapter({ llmExtractor: deps.llmExtractor });
  let lastResult: Awaited<ReturnType<typeof runIngestion>> | null = null;
  for await (const envelope of adapter.normalize({
    sourceRef: data.sourceRef,
    // exactOptionalPropertyTypes: spread hints only when a hint is present so
    // we never assign undefined to an optional property.
    ...(data.categoryHint !== undefined
      ? { hints: { categoryHint: data.categoryHint } }
      : {})
  })) {
    lastResult = await runIngestion({
      db: deps.db,
      audit: deps.audit,
      adapter,
      envelope,
      tenantId: data.tenantId,
      merchantId: data.merchantId,
      requestId: data.requestId,
      traceId: data.traceId
    });
  }
  return lastResult ?? { status: "no_envelopes" as const };
}

export function makeIngestionSpineProcessor(deps: IngestionSpineProcessorDeps) {
  return async (job: Job<IngestionSpineJobData>) => runSpineLink(deps, job.data);
}
