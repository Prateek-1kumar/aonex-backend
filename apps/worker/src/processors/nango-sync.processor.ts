// nango.sync queue processor — reacts to "sync complete" webhooks.
// Spawns a drain job per page rather than draining inline (the drain
// can take minutes; we want BullMQ retries at the page level).

import { JOB_KIND, QUEUE, STANDARD_RETRY, type NangoSyncEvent, MerchantId } from "@aonex/types";
import type { Job, Queue } from "bullmq";
import { fromProviderKey } from "@aonex/connector-gateway";
import type { AuditEmitter } from "@aonex/audit";
import { schema, type DrizzleClient } from "@aonex/db";
import { eq } from "drizzle-orm";

export interface NangoSyncProcessorDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
  drainQueue: Queue;
}

export function makeNangoSyncProcessor(deps: NangoSyncProcessorDeps) {
  return async (job: Job<NangoSyncEvent>) => {
    const event = job.data;
    const marketplace = fromProviderKey(event.providerConfigKey);
    if (!marketplace) return;

    // Resolve merchantId from connectionId.
    const conn = (
      await deps.db
        .select()
        .from(schema.marketplaceConnections)
        .where(eq(schema.marketplaceConnections.providerConnectionId, event.connectionId))
        .limit(1)
    )[0];
    if (!conn) {
      // Connection not found — webhook for revoked? Audit + drop.
      await deps.audit.emit({
        actorType: "nango",
        tenantId: conn?.tenantId ?? "00000000-0000-0000-0000-000000000000",
        eventType: "sync.unknown_connection",
        metadata: { connectionId: event.connectionId, providerConfigKey: event.providerConfigKey }
      });
      return;
    }

    const merchantId = MerchantId.unsafeFrom(conn.merchantId);

    // Record the sync run.
    const [run] = await deps.db
      .insert(schema.syncJobRuns)
      .values({
        tenantId: conn.tenantId,
        merchantId: conn.merchantId,
        marketplace,
        webhookId: job.id ?? "unknown",
        syncMode: event.syncType,
        startedAt: event.startedAt ? new Date(event.startedAt) : new Date(),
        recordsAdded: event.responseResults?.added ?? 0,
        recordsUpdated: event.responseResults?.updated ?? 0,
        recordsFailed: 0
      })
      .returning({ id: schema.syncJobRuns.id });

    // Enqueue drain.
    await deps.drainQueue.add(
      JOB_KIND.DRAIN,
      {
        merchantId,
        marketplace,
        syncJobRunId: run!.id,
        tenantId: conn.tenantId,
        modifiedAfter: event.modifiedAfter
      },
      {
        jobId: `drain:${conn.merchantId}:${marketplace}:${job.id}`,
        ...STANDARD_RETRY
      }
    );
  };
}

export const PROCESSOR_QUEUE = QUEUE.NANGO_SYNC;
