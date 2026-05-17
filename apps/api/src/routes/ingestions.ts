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
import { and, desc, eq } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";

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
  db: DrizzleClient;
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
        jobId: `link-extract-${tenantId}-${traceId}`,
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
            jobId: `link-extract-${tenantId}-${traceId}`,
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

  /**
   * GET /recent — recent link ingestions for the current tenant/merchant.
   * Each row joins source_artifacts (link_url lane only) with the latest
   * extraction_run + product_version + escalation metadata from rawData.
   */
  app.get("/recent", async (c) => {
    const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
    const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? "20")));

    const artifacts = await deps.db
      .select()
      .from(schema.sourceArtifacts)
      .where(
        and(
          eq(schema.sourceArtifacts.tenantId, tenantId),
          eq(schema.sourceArtifacts.merchantId, merchantId),
          eq(schema.sourceArtifacts.sourceType, "link_url")
        )
      )
      .orderBy(desc(schema.sourceArtifacts.receivedAt))
      .limit(limit);

    const hydrated = await Promise.all(
      artifacts.map(async (artifact) => {
        const run = await deps.db.query.extractionRuns.findFirst({
          where: (r, { eq }) => eq(r.artifactId, artifact.id),
          orderBy: (r, { desc }) => [desc(r.createdAt)],
        });
        let factCount = 0;
        if (run) {
          const factSet = await deps.db.query.extractedFactSets.findFirst({
            where: (fs, { eq }) => eq(fs.extractionRunId, run.id),
          });
          if (factSet) {
            const facts = await deps.db
              .select({ id: schema.extractedFacts.id })
              .from(schema.extractedFacts)
              .where(eq(schema.extractedFacts.factSetId, factSet.id));
            factCount = facts.length;
          }
        }
        // Pull escalation metadata from rawData (LinkAdapter stores it there per Phase 6).
        const raw = (artifact.rawData ?? {}) as Record<string, unknown>;
        return {
          artifact_id: artifact.id,
          source_external_id: artifact.sourceExternalId,
          status: artifact.status,
          received_at: artifact.receivedAt,
          checksum: artifact.checksum,
          // Phase 6 fields surfaced from rawData
          escalated_to: typeof raw.escalatedTo === "string" ? raw.escalatedTo : null,
          escalation_reasons: Array.isArray(raw.escalationReasons) ? raw.escalationReasons : [],
          cost_credits: typeof raw.costCredits === "number" ? raw.costCredits : 0,
          final_url: typeof raw.finalUrl === "string" ? raw.finalUrl : artifact.sourceExternalId,
          fact_count: factCount,
          extractor_version: run?.extractorVersion ?? null,
        };
      })
    );

    return c.json({ data: { ingestions: hydrated } });
  });

  /**
   * GET /:id/trace — per-stage audit_events for one source_artifact.
   * Returns the 7-stage trail (persist → extract → map → validate → score → diff → approve)
   * emitted by the ingestion-spine orchestrator.
   */
  app.get("/:id/trace", async (c) => {
    const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
    const id = c.req.param("id");

    // Verify the artifact belongs to this tenant before exposing audit events.
    const artifact = await deps.db.query.sourceArtifacts.findFirst({
      where: (a, { and, eq }) => and(eq(a.id, id), eq(a.tenantId, tenantId)),
    });
    if (!artifact) {
      return c.json({ error: { code: "NOT_FOUND", message: "Artifact not found" } }, 404);
    }

    const events = await deps.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.tenantId, tenantId),
          eq(schema.auditEvents.entityId, id)
        )
      )
      .orderBy(schema.auditEvents.createdAt);

    return c.json({
      data: {
        artifact: {
          id: artifact.id,
          source_external_id: artifact.sourceExternalId,
          status: artifact.status,
          received_at: artifact.receivedAt,
          processing_errors: artifact.processingErrors ?? [],
        },
        events: events.map((e) => ({
          id: e.id,
          event_type: e.eventType,
          stage: (e.metadata as Record<string, unknown> | null)?.stage ?? null,
          created_at: e.createdAt,
          metadata: e.metadata,
        })),
      },
    });
  });

  return app;
}
