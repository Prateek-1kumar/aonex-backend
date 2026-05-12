// nango.drain queue processor — pages records out of the gateway
// and writes them to source_artifacts with checksum-based dedup.
//
// HLD §11: "Persist source_artifacts ... before any processing".
// Phase 2 Field Extractor is enqueued only for newly-inserted rows.

import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import {
  QUEUE,
  TenantId,
  MerchantId,
  type Marketplace
} from "@aonex/types";
import type { ConnectorAdapterPhase1 } from "@aonex/connector-gateway";
import { schema, type DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import { SyncService } from "../services/sync-service.js";

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
  syncService: SyncService;
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

      const { inserted } = await deps.syncService.persistArtifacts({
        tenantId,
        merchantId,
        marketplace,
        syncJobRunId,
        records: page.map((r) => ({
          externalId: r.externalId,
          raw: r.raw,
          ...(r.modifiedAt ? { modifiedAt: r.modifiedAt } : {})
        }))
      });

      totalSeen += page.length;
      totalInserted += inserted;
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
