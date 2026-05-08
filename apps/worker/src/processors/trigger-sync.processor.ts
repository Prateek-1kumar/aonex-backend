// nango.trigger queue processor — kicks off a Nango sync run.
// Used both for initial-sync (after auth webhook) and manual-sync
// (from /api/sync/trigger).
//
// LLD §3: single in-flight per (merchant, marketplace) via Redis SETNX.

import type IORedis from "ioredis";
import type { Job } from "bullmq";
import { QUEUE, type Marketplace, type MerchantId, type TenantId } from "@aonex/types";
import { toProviderKey, SYNC_NAMES } from "@aonex/connector-gateway";
import type { NangoClient } from "@aonex/connector-gateway/adapters/nango";
import { SINGLE_FLIGHT_TTL_MS } from "../lib/job-options.js";

export interface TriggerSyncJobData {
  merchantId: MerchantId;
  marketplace: Marketplace;
  tenantId: TenantId;
}

export interface TriggerSyncProcessorDeps {
  client: NangoClient;
  redis: IORedis;
  /** Lookup connectionId from registry (port). */
  resolveConnectionId(input: { merchantId: MerchantId; marketplace: Marketplace }): Promise<string | null>;
}

export function makeTriggerSyncProcessor(deps: TriggerSyncProcessorDeps) {
  return async (job: Job<TriggerSyncJobData>) => {
    const { merchantId, marketplace } = job.data;
    const lockKey = `lock:sync:${merchantId}:${marketplace}`;
    const acquired = await deps.redis.set(
      lockKey,
      job.id ?? "1",
      "PX",
      SINGLE_FLIGHT_TTL_MS,
      "NX"
    );
    if (!acquired) {
      // Another in-flight sync — drop silently with audit-style log.
      return;
    }
    try {
      const connectionId = await deps.resolveConnectionId({ merchantId, marketplace });
      if (!connectionId) throw new Error(`No active connection ${merchantId}:${marketplace}`);
      const provider = toProviderKey(marketplace);
      const syncs = SYNC_NAMES[marketplace];
      if (syncs.length === 0) return;
      const c = deps.client as unknown as {
        triggerSync: (key: string, syncs: string[], connectionId: string) => Promise<void>;
      };
      await c.triggerSync(provider, [...syncs], connectionId);
    } finally {
      await deps.redis.del(lockKey);
    }
  };
}

export const PROCESSOR_QUEUE = QUEUE.NANGO_TRIGGER;
