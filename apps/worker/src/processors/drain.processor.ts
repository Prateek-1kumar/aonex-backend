// nango.drain queue processor — pages records out of the gateway
// and writes them to source_artifacts with checksum-based dedup.
//
// HLD §11: "Persist source_artifacts ... before any processing".
// Phase 2 Field Extractor is enqueued only for newly-inserted rows.

import { eq } from "drizzle-orm";
import type { Job, Queue } from "bullmq";
import {
  JOB_KIND,
  QUEUE,
  STANDARD_RETRY,
  TenantId,
  MerchantId,
  type Marketplace
} from "@aonex/types";
import { canonicalStringify, sha256Hex } from "@aonex/lib-utils";
import type { ConnectorAdapterPhase1 } from "@aonex/connector-gateway";
import { schema, type DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";

export interface DrainJobData {
  merchantId: MerchantId;
  tenantId: TenantId;
  marketplace: Marketplace;
  syncJobRunId: string;
  modifiedAfter?: string;
}

export interface DrainProcessorDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
  gateway: ConnectorAdapterPhase1;
  extractQueue: Queue;
}

export function makeDrainProcessor(deps: DrainProcessorDeps) {
  return async (job: Job<DrainJobData>) => {
    const { merchantId, marketplace, tenantId, syncJobRunId, modifiedAfter } = job.data;

    let totalSeen = 0;
    let totalInserted = 0;

    for await (const page of deps.gateway.drainProducts(
      { merchantId, marketplace },
      { ...(modifiedAfter ? { modifiedAfter: new Date(modifiedAfter) } : {}), pageSize: 100 }
    )) {
      // Extend lock per page (long drains).
      await job.extendLock(job.token!, 60_000);

      for (const record of page) {
        totalSeen += 1;
        const checksum = sha256Hex(canonicalStringify(record.raw));
        const inserted = await deps.db
          .insert(schema.sourceArtifacts)
          .values({
            tenantId,
            merchantId,
            sourceType: "marketplace_connector",
            sourceMarketplace: marketplace,
            sourceExternalId: record.externalId,
            rawData: record.raw,
            checksum,
            status: "pending",
            syncJobRunId,
            ...(record.modifiedAt ? { modifiedAt: record.modifiedAt } : {})
          })
          .onConflictDoNothing({
            target: [
              schema.sourceArtifacts.merchantId,
              schema.sourceArtifacts.sourceMarketplace,
              schema.sourceArtifacts.sourceExternalId,
              schema.sourceArtifacts.checksum
            ]
          })
          .returning({ id: schema.sourceArtifacts.id });

        if (inserted.length > 0) {
          totalInserted += 1;
          // Phase 2 hook — enqueue extraction for genuinely new artifacts.
          await deps.extractQueue.add(
            JOB_KIND.EXTRACT,
            { artifactId: inserted[0]!.id },
            { jobId: `extract:${inserted[0]!.id}`, ...STANDARD_RETRY }
          );
        }
      }
    }

    await deps.db
      .update(schema.syncJobRuns)
      .set({ completedAt: new Date(), recordsAdded: totalInserted })
      .where(eq(schema.syncJobRuns.id, syncJobRunId));

    await deps.audit.emit({
      tenantId,
      merchantId,
      actorType: "worker",
      eventType: "sync.drain_completed",
      entityType: "sync_job_run",
      entityId: syncJobRunId,
      metadata: { totalSeen, totalInserted, marketplace }
    });
  };
}

export const PROCESSOR_QUEUE = QUEUE.NANGO_DRAIN;
