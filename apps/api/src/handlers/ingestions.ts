// Handler functions for ingestion routes.
// Each function contains the full business logic extracted from routes/ingestions.ts.

import type { Context } from "hono";
import { z } from "zod";
import { QUEUE, JOB_KIND, TenantId, MerchantId } from "@aonex/types";
import { randomUUID, createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@aonex/db";
import { inspectCsv } from "@aonex/catalog-source-adapters";
import { convertFromFacts, type SkuJson } from "@aonex/ingestion-enrichment";
import type { IngestionsRouteDeps } from "../routes/ingestions.js";

const CSV_MAX_BYTES = Number(process.env.CSV_MAX_BYTES ?? 15 * 1024 * 1024); // ~15 MB
const CSV_MAX_ROWS = Number(process.env.CSV_MAX_ROWS ?? 50_000);

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

/**
 * POST /link — Submit a single URL for product extraction.
 * Returns 202 with job metadata. Extraction happens asynchronously.
 */
export async function submitLink(c: Context, deps: IngestionsRouteDeps): Promise<Response> {
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
}

/**
 * POST /link/batch — Submit multiple URLs for extraction.
 * Returns 202 with array of job metadata.
 */
export async function submitLinkBatch(c: Context, deps: IngestionsRouteDeps): Promise<Response> {
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
}

/**
 * POST /csv — Accept a multipart CSV upload. Fatal-validates synchronously,
 * persists a file-level source_artifact, enqueues a CSV_PARSE job, and returns
 * 202 { ingestionId, rowCount }. Per-row processing + partial-success error
 * reporting happen asynchronously in the csv-parse worker.
 */
export async function submitCsv(c: Context, deps: IngestionsRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);
  const requestId = (c.get("requestId" as never) as string) ?? randomUUID();

  let file: File | null = null;
  try {
    const form = await c.req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return c.json({ error: { code: "BAD_REQUEST", message: "Expected multipart/form-data with a 'file' field" } }, 400);
  }
  if (!file) {
    return c.json({ error: { code: "BAD_REQUEST", message: "Missing 'file' field" } }, 400);
  }
  const isCsv = file.type === "text/csv" || file.type === "application/vnd.ms-excel" || file.name.toLowerCase().endsWith(".csv");
  if (!isCsv) {
    return c.json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Only CSV files are accepted" } }, 415);
  }
  if (file.size > CSV_MAX_BYTES) {
    return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: `File exceeds ${CSV_MAX_BYTES} bytes` } }, 413);
  }

  const csv = await file.text();

  let inspect;
  try {
    inspect = inspectCsv(csv);
  } catch (err) {
    return c.json({ error: { code: "UNPROCESSABLE_ENTITY", message: err instanceof Error ? err.message : "Invalid CSV" } }, 422);
  }
  if (inspect.rowCount > CSV_MAX_ROWS) {
    return c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: `File exceeds ${CSV_MAX_ROWS} rows` } }, 413);
  }

  const observedAt = new Date().toISOString();
  const uploadId = randomUUID();
  const fileArtifactId = randomUUID();
  await deps.db.insert(schema.sourceArtifacts).values({
    id: fileArtifactId,
    tenantId,
    merchantId,
    sourceType: "templated_csv",
    sourceMarketplace: null,
    sourceExternalId: `csv:${file.name.slice(0, 120)}:${uploadId}`,
    parentArtifactId: null,
    rawData: { csv, filename: file.name, observedAt },
    checksum: createHash("sha256").update(csv).digest("hex"),
    status: "pending",
  });

  const traceId = randomUUID();
  await deps.queues[QUEUE.CSV_PARSE].add(
    JOB_KIND.CSV_PARSE,
    { tenantId, merchantId, fileArtifactId, requestId, traceId },
    {
      jobId: `csv-parse-${tenantId}-${fileArtifactId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  );

  await deps.audit.emit({
    tenantId, merchantId, actorType: "user",
    eventType: "ingestion.csv_submitted", entityType: "source_artifact",
    entityId: fileArtifactId, requestId,
    metadata: { filename: file.name, rowCount: inspect.rowCount },
  });

  return c.json({ data: { ingestionId: fileArtifactId, rowCount: inspect.rowCount, status: "accepted" } }, 202);
}

/**
 * GET /recent — recent link ingestions for the current tenant/merchant.
 * Each row joins source_artifacts (link_url lane only) with the latest
 * extraction_run + product_version + escalation metadata from rawData.
 */
export async function getRecentIngestions(c: Context, deps: IngestionsRouteDeps): Promise<Response> {
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
      const run = await deps.db.query.linkIngestionTraceRuns.findFirst({
        where: (r, { eq }) => eq(r.artifactId, artifact.id),
        orderBy: (r, { desc }) => [desc(r.createdAt)],
      });
      let factCount = 0;
      if (run) {
        const factSet = await deps.db.query.linkIngestionTraceSets.findFirst({
          where: (fs, { eq }) => eq(fs.extractionRunId, run.id),
        });
        if (factSet) {
          const facts = await deps.db
            .select({ id: schema.linkIngestionTraceFacts.id })
            .from(schema.linkIngestionTraceFacts)
            .where(eq(schema.linkIngestionTraceFacts.factSetId, factSet.id));
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
}

/**
 * GET /:id/trace — per-stage audit_events for one source_artifact.
 * Returns the 7-stage trail (persist → extract → map → validate → score → diff → approve)
 * emitted by the ingestion-spine orchestrator.
 */
export async function getIngestionTrace(c: Context, deps: IngestionsRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const id = c.req.param("id") as string;

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

  // Load the latest extracted fact set for this artifact and rebuild SkuJson on-demand.
  // Computing on-demand (rather than persisting skuJson) avoids a DB migration and keeps
  // the trace endpoint a thin view over the canonical extracted_facts table.
  let sku: SkuJson | null = null;
  try {
    const factSet = await deps.db.query.linkIngestionTraceSets.findFirst({
      where: (f, { eq }) => eq(f.artifactId, id),
      orderBy: (f, { desc }) => desc(f.createdAt),
    });
    if (factSet) {
      const factRows = await deps.db
        .select()
        .from(schema.linkIngestionTraceFacts)
        .where(eq(schema.linkIngestionTraceFacts.factSetId, factSet.id));

      const facts = factRows.map((r) => ({
        rawKey: r.rawKey,
        canonicalPath: r.canonicalPath ?? null,
        extractedValue: r.extractedValue,
        normalizedValue: r.normalizedValue,
        unit: r.unit ?? null,
        sourcePointer: r.sourcePointer ?? "",
        extractionMethod: r.extractionMethod ?? null,
        mappingMethod: r.mappingMethod ?? null,
        mappingCandidates: r.mappingCandidates ?? null,
        sourceAlternatives: r.sourceAlternatives ?? null,
        // numeric columns come back as strings from node-postgres — coerce to number
        confidence: r.confidence != null ? Number(r.confidence) : 0,
        approved: r.approved ?? false,
      }));

      const finalUrl = artifact.sourceExternalId ?? "";
      const ogImage =
        ((artifact.rawData as { ogImage?: string | null } | null) ?? {}).ogImage ?? null;
      sku = convertFromFacts(facts as never, finalUrl, { ogImage });
    }
  } catch (err) {
    // Don't fail the whole trace response if SkuJson rebuild fails — log and continue.
     
    console.warn("[trace] failed to rebuild SkuJson:", err);
  }

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
      sku,
    },
  });
}
