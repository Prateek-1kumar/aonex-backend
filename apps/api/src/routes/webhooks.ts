// /webhooks/nango — fast-ack with QUEUE-FIRST ordering (LLD P0-1 fix).
//
// Order:
//   1. Read raw body via c.req.text() — never re-stringify
//   2. gateway.verifyAndParseWebhook → throws GatewayError on bad sig
//   3. ENQUEUE BullMQ job (jobId = webhookId for layer-2 idempotency)
//   4. INSERT processed_webhooks ON CONFLICT DO NOTHING (layer 1)
//   5. Return 202 Accepted
//
// Why queue-first: if step 3 succeeds and step 4 fails, the worker
// runs the job and the next delivery is still deduped at the staging
// UNIQUE (layer 3). If we reversed (mark-first) and step 3 then
// failed, we'd silently drop the webhook with no way to recover.

import { Hono } from "hono";
import { QUEUE, STANDARD_RETRY } from "@aonex/types";
import type { ConnectorAdapterPhase1 } from "@aonex/connector-gateway";
import type { Queue } from "bullmq";
import { schema, type DrizzleClient } from "@aonex/db";

export interface WebhookDeps {
  gateway: ConnectorAdapterPhase1;
  db: DrizzleClient;
  queues: {
    [QUEUE.NANGO_AUTH]: Queue;
    [QUEUE.NANGO_SYNC]: Queue;
  };
}

export function webhookRoutes(deps: WebhookDeps): Hono {
  const app = new Hono();

  app.post("/nango", async (c) => {
    // STEP 1: raw body — we MUST hash exactly the bytes Nango signed.
    const rawBody = await c.req.text();
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(c.req.header())) headers[k] = v;

    // STEP 2: HMAC verify + schema parse + freshness check (sync events).
    const { event, webhookId } = await deps.gateway.verifyAndParseWebhook({ rawBody, headers });

    // STEP 3 (queue-first): enqueue BEFORE marking processed.
    const queue = event.type === "auth" ? deps.queues[QUEUE.NANGO_AUTH] : deps.queues[QUEUE.NANGO_SYNC];
    await queue.add(event.type, event, {
      jobId: webhookId,
      ...STANDARD_RETRY
    });

    // STEP 4: layer-1 idempotency. Replays after this point are no-ops.
    await deps.db
      .insert(schema.processedWebhooks)
      .values({ webhookId })
      .onConflictDoNothing();

    // STEP 5: 202 — Nango does not retry on 202.
    return c.json({ received: true, webhookId }, 202);
  });

  return app;
}
