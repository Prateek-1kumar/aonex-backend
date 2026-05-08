// /api/sync/trigger — manual sync trigger.
// HLD §24.1: rate limit 60s/SKU/tenant; Phase 1 implements
// per-(merchant,marketplace) cap of 1 in-flight via Redis SETNX
// in the worker (not here).

import { Hono } from "hono";
import { z } from "zod";
import { JOB_KIND, MARKETPLACES, MerchantId, QUEUE, STANDARD_RETRY, TenantId } from "@aonex/types";
import type { Queue } from "bullmq";
import type { AuditEmitter } from "@aonex/audit";

export interface SyncDeps {
  queues: { [QUEUE.NANGO_TRIGGER]: Queue };
  audit: AuditEmitter;
}

const TriggerBody = z.object({ marketplace: z.enum(MARKETPLACES) });

export function syncRoutes(deps: SyncDeps): Hono {
  const app = new Hono();

  app.post("/trigger", async (c) => {
    const body = TriggerBody.parse(await c.req.json());
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId") as string);
    const tenantId = TenantId.unsafeFrom(c.get("tenantId") as string);
    await deps.queues[QUEUE.NANGO_TRIGGER].add(
      JOB_KIND.MANUAL_SYNC,
      { merchantId, marketplace: body.marketplace, tenantId },
      {
        jobId: `manual:${merchantId}:${body.marketplace}`,
        ...STANDARD_RETRY,
        priority: 1 // manual jumps queue per LLD §3
      }
    );
    await deps.audit.emit({
      tenantId,
      merchantId,
      actorId: merchantId,
      actorType: "user",
      eventType: "sync.manually_triggered",
      entityType: "marketplace_connection",
      entityId: `${merchantId}:${body.marketplace}`,
      requestId: c.get("requestId") as string
    });
    return c.json({ data: { ok: true } });
  });

  return app;
}
