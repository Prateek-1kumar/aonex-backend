// ingestion.link_extract queue processor — fetches a URL, runs
// structured-first extraction with LLM gap-fill, and persists
// source_artifact + extracted facts.
//
// HLD §11.4: "Static URL ingestion — Fetcher, robots/compliance
// review, HTML snapshot storage, DOM provenance."
// HLD §4: "Persist the raw source and checksum before extraction."
// HLD §22.3: "Model output becomes extracted facts, never direct writes."

import type { Job } from "bullmq";
import { eq, desc } from "drizzle-orm";
import type { TenantId, MerchantId, ProductId } from "@aonex/types";
import { QUEUE } from "@aonex/types";
import type { DedupeDecision } from "@aonex/ingestion-deduplicator";
import { schema, type DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import { sha256Hex, domainOf } from "@aonex/lib-utils";
import { fetchLink, type LinkFetchResult, LinkFetchError } from "@aonex/ingestion-link-fetcher";
import { LLMProductExtractor, LLM_EXTRACTOR_VERSION } from "@aonex/ingestion-llm-extractor";
import type { ExtractedFact, ExtractedFactSet } from "@aonex/ingestion-field-extractor";
import type { ArtifactId } from "@aonex/types";
import { extractStructured, checkCoverage } from "@aonex/ingestion-structured";
import { persistLinkCatalogPipeline } from "../services/link-catalog-pipeline.js";
import { emitFailureReviewTask } from "../services/emit-failure-review-task.js";
import { runSpineLink } from "./ingestion-spine.processor.js";

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
    // PHASE 2: feature-flag dispatch to the unified ingestion spine.
    // When INGESTION_SPINE_ENABLED=true, route this job through runSpineLink
    // instead of the legacy code path below. Both paths are idempotent so
    // a flag flip mid-flight is safe.
    if (process.env.INGESTION_SPINE_ENABLED === "true") {
      return runSpineLink(
        { db: deps.db, audit: deps.audit, llmExtractor: deps.extractor },
        {
          tenantId: job.data.tenantId,
          merchantId: job.data.merchantId,
          lane: "link",
          sourceRef: job.data.url,
          ...(job.data.categoryHint !== undefined ? { categoryHint: job.data.categoryHint } : {}),
          requestId: job.data.requestId,
          traceId: job.data.traceId
        }
      );
    }

    // Legacy path follows below — unchanged.
    const { tenantId, merchantId, url, categoryHint, requestId, traceId } = job.data;

    // ── Step 1: Fetch HTML ──────────────────────────────────────────
    let fetchResult: LinkFetchResult;
    try {
      fetchResult = await fetchLink(url);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error
        ? err.message
        : `Fetch failed: ${String(err)}`;
      const statusCode = err instanceof LinkFetchError ? err.statusCode ?? null : null;

      // Persist a failed source_artifact for audit trail
      const [failedArtifact] = await deps.db.insert(schema.sourceArtifacts).values({
        tenantId,
        merchantId,
        sourceType: "link_url",
        sourceExternalId: url,
        rawData: { url, error: errorMessage },
        checksum: sha256Hex(url + errorMessage),
        status: "failed",
        processingErrors: [{ step: "fetch", error: errorMessage }],
      })
        .onConflictDoNothing()
        .returning({ id: schema.sourceArtifacts.id });

      await deps.audit.emit({
        tenantId,
        merchantId,
        actorType: "worker",
        eventType: "ingestion.link_fetch_failed",
        entityType: "source_artifact",
        entityId: url,
        requestId,
        metadata: { url, error: errorMessage, statusCode },
      });

      // Surface in Anomaly Lab so the user sees blocked URLs instead of silence.
      await emitFailureReviewTask({
        db: deps.db,
        tenantId,
        merchantId,
        artifactId: (failedArtifact?.id as ArtifactId | undefined) ?? null,
        signalKind: "fetch_failed",
        url,
        reasonText: errorMessage,
        evidence: { statusCode, errorMessage },
      });

      // BullMQ retries on throw. Once a review task is logged, we don't want
      // to re-attempt indefinitely — exit cleanly so the failure stays visible.
      return;
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

      await emitFailureReviewTask({
        db: deps.db,
        tenantId,
        merchantId,
        artifactId: null,
        signalKind: "artifact_duplicate",
        url: fetchResult.finalUrl,
        reasonText: "URL already ingested with identical content checksum",
        evidence: { checksum: fetchResult.contentChecksum, finalUrl: fetchResult.finalUrl },
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

    // ── Step 3: Structured-first extraction ────────────────────────
    const structuredResult = await extractStructured({
      pageUrl: fetchResult.finalUrl,
      rawHtml: fetchResult.rawHtml,
      structuredBlocks: fetchResult.structuredBlocks,
      categoryRequiredAttributes: [],
    });

    // 3a. Captcha wall → fail-fast
    if (structuredResult.captchaSignal) {
      await deps.db
        .update(schema.sourceArtifacts)
        .set({
          status: "failed",
          processingErrors: [{ step: "structured", error: "captcha_wall" }],
        })
        .where(eq(schema.sourceArtifacts.id, artifactId));

      await deps.db.insert(schema.extractionFailures).values({
        tenantId,
        domainPattern: domainOf(fetchResult.finalUrl),
        reason: "captcha_wall",
        sourcePointer: `body ${fetchResult.rawHtml.length} bytes; captcha keywords matched`,
      });

      await deps.audit.emit({
        tenantId,
        merchantId,
        actorType: "worker",
        eventType: "ingestion.captcha_wall",
        entityType: "source_artifact",
        entityId: artifactId,
        requestId,
        metadata: { url: fetchResult.finalUrl },
      });

      await emitFailureReviewTask({
        db: deps.db,
        tenantId,
        merchantId,
        artifactId,
        signalKind: "captcha_wall",
        url: fetchResult.finalUrl,
        reasonText: "Page served a CAPTCHA / bot-wall instead of product data",
        evidence: {
          bodyLength: fetchResult.rawHtml.length,
          statusCode: fetchResult.statusCode,
        },
      });
      return;
    }

    // 3b. Load required attributes for the detected category and re-check coverage
    const categoryRequired = structuredResult.structured.category.path
      ? await loadCategoryRequiredAttributes(deps.db, structuredResult.structured.category.path)
      : [];

    const coverage = checkCoverage(structuredResult.structured.facts, categoryRequired);

    // 3c. LLM gap-fill (only when coverage is incomplete)
    let llmFacts: ExtractedFact[] = [];
    let llmMeta = {
      modelName: null as string | null,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCostUsd: 0,
    };

    if (!coverage.complete) {
      if (structuredResult.structured.facts.length === 0) {
        // Zero coverage → full LLM extraction
        const result = await deps.extractor.extract(
          fetchResult.cleanedText,
          fetchResult.finalUrl,
          artifactId,
          categoryHint ? { categoryHint } : undefined
        );
        llmFacts = result.facts;
        llmMeta = {
          modelName: result.modelName,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          estimatedCostUsd: result.estimatedCostUsd,
        };
      } else {
        // Partial coverage → gap-fill only the missing fields
        const gapResult = await deps.extractor.extractGapFill(
          fetchResult.cleanedText,
          fetchResult.finalUrl,
          artifactId,
          {
            gaps: coverage.gaps,
            structuredFacts: structuredResult.structured.facts.map((f) => ({
              rawKey: f.rawKey,
              value: f.extractedValue,
              source: f.sourcePointer,
            })),
            categoryCandidates: structuredResult.structured.category.path
              ? [structuredResult.structured.category.path]
              : [],
          }
        );
        llmFacts = gapResult.facts;
        llmMeta = {
          modelName: gapResult.modelName,
          promptTokens: gapResult.promptTokens,
          completionTokens: gapResult.completionTokens,
          estimatedCostUsd: gapResult.estimatedCostUsd,
        };
      }
    }

    // 3d. Combine structured + LLM facts
    const factSet: ExtractedFactSet = {
      artifactId,
      marketplace: "link_url",
      extractorVersion: LLM_EXTRACTOR_VERSION,
      facts: [...structuredResult.structured.facts, ...llmFacts],
      extractedAt: new Date(),
    };

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
        metadata: { url, model: llmMeta.modelName, cost: llmMeta.estimatedCostUsd },
      });

      await emitFailureReviewTask({
        db: deps.db,
        tenantId,
        merchantId,
        artifactId,
        signalKind: "no_data_extracted",
        url: fetchResult.finalUrl,
        reasonText: "Parsers and LLM both returned zero product facts",
        evidence: {
          model: llmMeta.modelName,
          estimatedCostUsd: llmMeta.estimatedCostUsd,
          structuredFactsCount: 0,
        },
      });
      return;
    }

    // ── Step 4: Persist canonical proposal / catalog version ─────────
    // Plan D Task 16: real source reliability from domain_profiles.
    const profile = await deps.db.query.domainProfiles.findFirst({
      where: (p, { eq }) => eq(p.domainPattern, domainOf(fetchResult.finalUrl)),
    });
    const sourceReliability =
      profile?.avgConfidence != null
        ? Math.max(0, Math.min(1, Number(profile.avgConfidence)))
        : 0.65; // fallback when no profile exists yet

    const canonicalGtin = findFactValue(factSet.facts, "gtin");
    const canonicalMpn =
      findFactValue(factSet.facts, "mpn") ??
      findFactValue(factSet.facts, "model_number");
    const dedupeDecision = await resolveDedupe({
      db: deps.db,
      tenantId,
      gtin: canonicalGtin,
      mpn: canonicalMpn,
    });

    const catalogResult = await persistLinkCatalogPipeline({
      db: deps.db,
      tenantId,
      merchantId,
      artifactId,
      sourceUrl: fetchResult.finalUrl,
      factSet,
      suggestedCategory: structuredResult.structured.category.path,
      categoryConfidence: structuredResult.structured.category.confidence,
      extractorMeta: llmMeta,
      dedupeDecision,
      sourceReliability,
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
        structuredFactsCount: structuredResult.structured.facts.length,
        llmFactsCount: llmFacts.length,
        coverageComplete: coverage.complete,
        suggestedCategory: structuredResult.structured.category.path,
        categoryConfidence: structuredResult.structured.category.confidence,
        model: llmMeta.modelName,
        promptTokens: llmMeta.promptTokens,
        completionTokens: llmMeta.completionTokens,
        estimatedCostUsd: llmMeta.estimatedCostUsd,
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
      suggestedCategory: structuredResult.structured.category.path,
      categoryConfidence: structuredResult.structured.category.confidence,
      estimatedCostUsd: llmMeta.estimatedCostUsd,
      route: catalogResult.route,
      confidenceScore: catalogResult.confidenceScore,
      proposedDiffId: catalogResult.proposedDiffId,
      productId: catalogResult.productId,
      productVersionId: catalogResult.productVersionId,
    };
  };
}

export const PROCESSOR_QUEUE = QUEUE.LINK_EXTRACT;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve dedup decision by checking GTIN and MPN against product_identities.
 * Returns "merge" with the existing product ID if a match is found, else "new".
 */
async function resolveDedupe(args: {
  db: DrizzleClient;
  tenantId: TenantId;
  gtin: string | null;
  mpn: string | null;
}): Promise<DedupeDecision> {
  const checks: { type: "gtin" | "mpn"; value: string }[] = [];
  if (args.gtin) checks.push({ type: "gtin", value: args.gtin });
  if (args.mpn) checks.push({ type: "mpn", value: args.mpn });
  for (const c of checks) {
    const row = await args.db.query.productIdentities.findFirst({
      where: (i, { and, eq }) =>
        and(
          eq(i.tenantId, args.tenantId),
          eq(i.identityType, c.type),
          eq(i.identityValue, c.value)
        ),
    });
    if (row) {
      return {
        kind: "merge",
        productId: row.productId as ProductId,
        reason: c.type === "gtin" ? "gtin_match" : "mpn_match",
      };
    }
  }
  return { kind: "new" };
}

/**
 * Extract the canonical string value for a raw key from an ExtractedFact array.
 * Prefers normalizedValue over extractedValue.
 */
function findFactValue(facts: ExtractedFact[], rawKey: string): string | null {
  const f = facts.find((x) => x.rawKey === rawKey);
  const v = f?.normalizedValue ?? f?.extractedValue;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Load required attribute keys for the given category path from
 * category_schemas. Returns an empty array when no schema exists.
 */
async function loadCategoryRequiredAttributes(
  db: DrizzleClient,
  categoryPath: string
): Promise<string[]> {
  const row = await db.query.categorySchemas.findFirst({
    where: (c, { eq }) => eq(c.categoryPath, categoryPath),
    orderBy: (c, { desc }) => [desc(c.schemaVersion)],
  });
  return row?.requiredAttributes ?? [];
}
