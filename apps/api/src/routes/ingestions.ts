// POST /api/ingestions/link — accept a URL for LLM-based product extraction.
//
// HLD §19: API contracts. This is the link ingestion counterpart
// to POST /v1/ingestions/csv.
// HLD §7: "Enqueue and return immediately. All work must be replayable."

import { Hono } from "hono";
import { z } from "zod";
import type { Queue } from "bullmq";
import type { AuditEmitter } from "@aonex/audit";
import { QUEUE, TenantId, MerchantId } from "@aonex/types";
import { randomUUID } from "node:crypto";

const LinkIngestionBodySchema = z.object({
  /** The URL to extract product data from. Must be HTTP or HTTPS. */
  url: z.string().url().refine(
    (url) => url.startsWith("http://") || url.startsWith("https://"),
    { message: "URL must use HTTP or HTTPS protocol" }
  ),
  /** Optional category hint to guide the LLM extraction. */
  category_hint: z.string().max(200).optional(),
});

const BatchLinkIngestionBodySchema = z.object({
  /** Array of URLs to extract product data from. Max 20 per batch. */
  urls: z.array(
    z.string().url().refine(
      (url) => url.startsWith("http://") || url.startsWith("https://"),
      { message: "URL must use HTTP or HTTPS protocol" }
    )
  ).min(1).max(20),
  /** Optional category hint applied to all URLs. */
  category_hint: z.string().max(200).optional(),
});

export interface IngestionsRouteDeps {
  queues: { [QUEUE.LINK_EXTRACT]: Queue };
  audit: AuditEmitter;
}

export function ingestionsRoutes(deps: IngestionsRouteDeps) {
  const app = new Hono();

  /**
   * POST /link — Submit a single URL for product extraction.
   * Returns 202 with job metadata. Extraction happens asynchronously.
   */
  app.post("/link", async (c) => {
    const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);
    const requestId = (c.get("requestId" as never) as string) ?? randomUUID();

    const body = await c.req.json();
    const parsed = LinkIngestionBodySchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Validation failed",
          details: parsed.error.errors,
        },
        400
      );
    }

    const { url, category_hint } = parsed.data;
    const traceId = randomUUID();

    // Enqueue link extraction job
    const job = await deps.queues[QUEUE.LINK_EXTRACT].add(
      "link-extract",
      {
        tenantId,
        merchantId,
        url,
        categoryHint: category_hint,
        requestId,
        traceId,
      },
      {
        jobId: `link-extract:${tenantId}:${url}`,
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      }
    );

    await deps.audit.emit({
      tenantId,
      merchantId,
      actorType: "user",
      eventType: "ingestion.link_submitted",
      entityType: "ingestion_job",
      entityId: job.id ?? traceId,
      requestId,
      metadata: { url, categoryHint: category_hint },
    });

    return c.json(
      {
        success: true,
        data: {
          ingestion_id: job.id,
          trace_id: traceId,
          url,
          status: "accepted",
          message: "URL accepted. Extraction will continue asynchronously.",
        },
      },
      202
    );
  });

  /**
   * POST /link/batch — Submit multiple URLs for extraction.
   * Returns 202 with array of job metadata.
   */
  app.post("/link/batch", async (c) => {
    const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);
    const requestId = (c.get("requestId" as never) as string) ?? randomUUID();

    const body = await c.req.json();
    const parsed = BatchLinkIngestionBodySchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Validation failed",
          details: parsed.error.errors,
        },
        400
      );
    }

    const { urls, category_hint } = parsed.data;
    const batchId = randomUUID();

    const jobs = await Promise.all(
      urls.map(async (url) => {
        const traceId = randomUUID();
        const job = await deps.queues[QUEUE.LINK_EXTRACT].add(
          "link-extract",
          {
            tenantId,
            merchantId,
            url,
            categoryHint: category_hint,
            requestId,
            traceId,
          },
          {
            jobId: `link-extract:${tenantId}:${url}`,
            removeOnComplete: 1000,
            removeOnFail: 5000,
            attempts: 3,
            backoff: { type: "exponential", delay: 5000 },
          }
        );

        return {
          ingestion_id: job.id,
          trace_id: traceId,
          url,
          status: "accepted" as const,
        };
      })
    );

    await deps.audit.emit({
      tenantId,
      merchantId,
      actorType: "user",
      eventType: "ingestion.link_batch_submitted",
      entityType: "ingestion_job",
      entityId: batchId,
      requestId,
      metadata: { urlCount: urls.length, batchId },
    });

    return c.json(
      {
        success: true,
        data: {
          batch_id: batchId,
          status: "accepted",
          total: urls.length,
          jobs,
          message: `${urls.length} URL(s) accepted. Extraction will continue asynchronously.`,
        },
      },
      202
    );
  });

  return app;
}
