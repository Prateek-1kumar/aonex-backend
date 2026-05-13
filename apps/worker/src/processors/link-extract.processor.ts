// ingestion.link_extract queue processor — fetches a URL, runs
// LLM extraction, and persists source_artifact + extracted facts.
//
// HLD §11.4: "Static URL ingestion — Fetcher, robots/compliance
// review, HTML snapshot storage, DOM provenance."
// HLD §4: "Persist the raw source and checksum before extraction."
// HLD §22.3: "Model output becomes extracted facts, never direct writes."

import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import type { TenantId, MerchantId } from "@aonex/types";
import { QUEUE } from "@aonex/types";
import { schema, type DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import { sha256Hex } from "@aonex/lib-utils";
import { fetchLink, type LinkFetchResult, LinkFetchError } from "@aonex/ingestion-link-fetcher";
import { LLMProductExtractor, LLM_EXTRACTOR_VERSION } from "@aonex/ingestion-llm-extractor";
import type { ArtifactId } from "@aonex/types";
import { persistLinkCatalogPipeline } from "../services/link-catalog-pipeline.js";

export interface LinkExtractJobData {
  tenantId: TenantId;
  merchantId: MerchantId;
  url: string;
  categoryHint?: string;
  requestId: string;
  traceId: string;
}

export interface LinkExtractProcessorDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
  extractor: LLMProductExtractor;
}

export function makeLinkExtractProcessor(deps: LinkExtractProcessorDeps) {
  return async (job: Job<LinkExtractJobData>) => {
    const { tenantId, merchantId, url, categoryHint, requestId, traceId } = job.data;

    // ── Step 1: Fetch HTML ──────────────────────────────────────────
    let fetchResult: LinkFetchResult;
    try {
      fetchResult = await fetchLink(url);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error
        ? err.message
        : `Fetch failed: ${String(err)}`;

      // Persist a failed source_artifact for audit trail
      await deps.db.insert(schema.sourceArtifacts).values({
        tenantId,
        merchantId,
        sourceType: "link_url",
        sourceExternalId: url,
        rawData: { url, error: errorMessage },
        checksum: sha256Hex(url + errorMessage),
        status: "failed",
        processingErrors: [{ step: "fetch", error: errorMessage }],
      }).onConflictDoNothing();

      await deps.audit.emit({
        tenantId,
        merchantId,
        actorType: "worker",
        eventType: "ingestion.link_fetch_failed",
        entityType: "source_artifact",
        entityId: url,
        requestId,
        metadata: { url, error: errorMessage },
      });

      throw new Error(errorMessage);
    }

    // ── Step 2: Persist source_artifact (evidence first) ────────────
    const [artifact] = await deps.db
      .insert(schema.sourceArtifacts)
      .values({
        tenantId,
        merchantId,
        sourceType: "link_url",
        sourceExternalId: url,
        rawData: {
          url: fetchResult.url,
          finalUrl: fetchResult.finalUrl,
          statusCode: fetchResult.statusCode,
          contentType: fetchResult.contentType,
          fetchedAt: fetchResult.fetchedAt.toISOString(),
          // Store a truncated snapshot in raw_data (full HTML would go to object storage)
          htmlSnippet: fetchResult.rawHtml.substring(0, 10_000),
          cleanedTextLength: fetchResult.cleanedText.length,
        },
        checksum: fetchResult.contentChecksum,
        status: "processing",
      })
      .onConflictDoNothing()
      .returning({ id: schema.sourceArtifacts.id });

    // If artifact already exists (dedup hit), skip extraction
    if (!artifact) {
      await deps.audit.emit({
        tenantId,
        merchantId,
        actorType: "worker",
        eventType: "ingestion.link_dedup_skipped",
        entityType: "source_artifact",
        entityId: url,
        requestId,
        metadata: { url, checksum: fetchResult.contentChecksum },
      });
      return;
    }

    const artifactId = artifact.id as ArtifactId;

    await deps.audit.emit({
      tenantId,
      merchantId,
      actorType: "worker",
      eventType: "ingestion.artifact_created",
      entityType: "source_artifact",
      entityId: artifactId,
      requestId,
      metadata: { url: fetchResult.finalUrl, sourceType: "link_url" },
    });

    // ── Step 3: LLM extraction ──────────────────────────────────────
    let extractionResult;
    try {
      extractionResult = await deps.extractor.extractFactSet(
        fetchResult.cleanedText,
        fetchResult.finalUrl,
        artifactId,
        categoryHint ? { categoryHint } : undefined
      );
    } catch (err) {
      const errorMessage = `LLM extraction failed: ${err instanceof Error ? err.message : String(err)}`;

      // Mark artifact as failed but preserve the raw evidence
      await deps.db
        .update(schema.sourceArtifacts)
        .set({
          status: "failed",
          processingErrors: [{ step: "llm_extraction", error: errorMessage }],
        })
        .where(eq(schema.sourceArtifacts.id, artifactId));

      await deps.audit.emit({
        tenantId,
        merchantId,
        actorType: "worker",
        eventType: "ingestion.extraction_failed",
        entityType: "source_artifact",
        entityId: artifactId,
        requestId,
        metadata: { url, error: errorMessage },
      });

      throw new Error(errorMessage);
    }

    const { factSet, meta } = extractionResult;

    if (factSet.facts.length === 0) {
      // No product data extracted — mark as needs_review
      await deps.db
        .update(schema.sourceArtifacts)
        .set({ status: "needs_review" })
        .where(eq(schema.sourceArtifacts.id, artifactId));

      await deps.audit.emit({
        tenantId,
        merchantId,
        actorType: "worker",
        eventType: "ingestion.no_product_found",
        entityType: "source_artifact",
        entityId: artifactId,
        requestId,
        metadata: { url, model: meta.modelName, cost: meta.estimatedCostUsd },
      });
      return;
    }

    // ── Step 4: Persist canonical proposal / catalog version ─────────
    const catalogResult = await persistLinkCatalogPipeline({
      db: deps.db,
      tenantId,
      merchantId,
      artifactId,
      sourceUrl: fetchResult.finalUrl,
      factSet,
      suggestedCategory: meta.suggestedCategory,
      categoryConfidence: meta.categoryConfidence,
      extractorMeta: {
        modelName: meta.modelName,
        promptTokens: meta.promptTokens,
        completionTokens: meta.completionTokens,
        estimatedCostUsd: meta.estimatedCostUsd,
      },
    });

    // Mark artifact as completed or review-gated after facts/diff persistence.
    await deps.db
      .update(schema.sourceArtifacts)
      .set({ status: catalogResult.route === "review" ? "needs_review" : "completed" })
      .where(eq(schema.sourceArtifacts.id, artifactId));

    // ── Step 5: Audit trail ─────────────────────────────────────────
    await deps.audit.emit({
      tenantId,
      merchantId,
      actorType: "worker",
      eventType: "ingestion.extraction_completed",
      entityType: "source_artifact",
      entityId: artifactId,
      requestId,
      metadata: {
        url: fetchResult.finalUrl,
        factsCount: factSet.facts.length,
        suggestedCategory: meta.suggestedCategory,
        categoryConfidence: meta.categoryConfidence,
        model: meta.modelName,
        promptTokens: meta.promptTokens,
        completionTokens: meta.completionTokens,
        estimatedCostUsd: meta.estimatedCostUsd,
        extractorVersion: LLM_EXTRACTOR_VERSION,
        extractionRunId: catalogResult.extractionRunId,
        factSetId: catalogResult.factSetId,
        proposedDiffId: catalogResult.proposedDiffId,
        route: catalogResult.route,
        confidenceScore: catalogResult.confidenceScore,
        productId: catalogResult.productId,
        productVersionId: catalogResult.productVersionId,
      },
    });

    // Return the extraction result for downstream consumers
    return {
      artifactId,
      factsCount: factSet.facts.length,
      suggestedCategory: meta.suggestedCategory,
      categoryConfidence: meta.categoryConfidence,
      estimatedCostUsd: meta.estimatedCostUsd,
      route: catalogResult.route,
      confidenceScore: catalogResult.confidenceScore,
      proposedDiffId: catalogResult.proposedDiffId,
      productId: catalogResult.productId,
      productVersionId: catalogResult.productVersionId,
    };
  };
}

export const PROCESSOR_QUEUE = QUEUE.LINK_EXTRACT;
