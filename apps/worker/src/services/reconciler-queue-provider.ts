// Producer side of the per-tenant async reconcile queue (`recon.<tenantId>`).
// Mirrors apps/api/src/queues/client.ts: caches one BullMQ Queue per tenant
// over a shared ioredis connection so the catalog write path doesn't pay a
// Queue construct/close per product. The consumer side (one Worker per tenant)
// lives in jobs/reconciler-async.ts.

import { Queue } from "bullmq";
import type IORedis from "ioredis";
import { reconcilerQueueName } from "@aonex/catalog-service";

export class ReconcilerQueueProvider {
  private readonly queues = new Map<string, Queue>();
  constructor(private readonly connection: IORedis) {}

  /** Get (or lazily create) the reconcile producer Queue for a tenant. */
  forTenant(tenantId: string): Queue {
    let q = this.queues.get(tenantId);
    if (!q) {
      q = new Queue(reconcilerQueueName(tenantId), { connection: this.connection });
      this.queues.set(tenantId, q);
    }
    return q;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
