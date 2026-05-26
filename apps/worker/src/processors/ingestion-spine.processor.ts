import type { DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import { runIngestion } from "@aonex/ingestion-spine";
import type { IngestionEnvelope } from "@aonex/ingestion-spine";
import { createLinkAdapter, createLinkAdapterWithAntibot } from "@aonex/link-adapter";
import { LLMProductExtractor } from "@aonex/ingestion-llm-extractor";
import { channelCodeFromUrl } from "@aonex/catalog-source-adapters";
import type { SkuJson } from "@aonex/ingestion-enrichment";
import type { TenantId, MerchantId, ArtifactId } from "@aonex/types";
import { runNewLinkCatalogPath, resolveChannelByCode } from "../services/new-catalog-link-path.js";

export interface IngestionSpineJobData {
  tenantId: TenantId;
  merchantId: MerchantId;
  lane: "link";    // CSV added in Phase 4
  sourceRef: string;
  categoryHint?: string;
  requestId: string;
  traceId: string;
}

export interface IngestionSpineProcessorDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
  llmExtractor: LLMProductExtractor;
}

/**
 * Inner function the legacy link-extract processor can call directly
 * via feature-flag dispatch, avoiding the need to synthesize a Job<>.
 */
export async function runSpineLink(
  deps: IngestionSpineProcessorDeps,
  data: IngestionSpineJobData
) {
  if (data.lane !== "link") {
    throw new Error(`Lane ${data.lane} not implemented in Phase 2`);
  }
  // Phase 6 Layer D wiring: when SCRAPINGBEE_API_KEY is set, the antibot factory
  // builds a LinkAdapter with the unblock layer active. When unset, it falls
  // back to a plain LinkAdapter (browser-only escalation). Both paths share
  // the same LinkAdapterDeps so callers are unaffected.
  const adapter = await createLinkAdapterWithAntibot({ llmExtractor: deps.llmExtractor });
  void createLinkAdapter;    // keep the export reachable for direct callers/tests
  let lastResult: Awaited<ReturnType<typeof runIngestion>> | null = null;
  for await (const envelope of adapter.normalize({
    sourceRef: data.sourceRef,
    // exactOptionalPropertyTypes: spread hints only when a hint is present so
    // we never assign undefined to an optional property.
    ...(data.categoryHint !== undefined
      ? { hints: { categoryHint: data.categoryHint } }
      : {})
  })) {
    lastResult = await runIngestion({
      db: deps.db,
      audit: deps.audit,
      adapter,
      envelope,
      tenantId: data.tenantId,
      merchantId: data.merchantId,
      requestId: data.requestId,
      traceId: data.traceId
    });

    // Land the extracted product in the canonical catalog (or anomaly lab).
    // The spine itself only writes the trace + proposed_diff/review_task and
    // never touches catalog_products, so without this the product shows up in
    // ingestion history but never in the catalog. See writeSpineExtractionToCatalog.
    await writeSpineExtractionToCatalog(deps, data, envelope, lastResult);
  }
  return lastResult ?? { status: "no_envelopes" as const };
}

/**
 * Bridge a spine extraction into the canonical catalog.
 *
 * The spine writes the trace + proposed_diff/review_task but — by design, to
 * keep the spine package free of a @aonex/catalog-service dependency — does NOT
 * write to catalog_products. This wrapper hands the already-extracted SkuJson
 * (surfaced on the run result as `skuJson`) to the same tested
 * `runNewLinkCatalogPath` the legacy path uses. `admitOrStage` inside it then
 * admits the product to the catalog or stages it to the anomaly lab per the
 * CANONICAL_MINIMUM readiness gate.
 *
 * Best-effort: a failure here is audited but does NOT throw, because the
 * trace/diff already committed in `runIngestion`. A BullMQ retry would re-enter
 * the spine, hit the artifact-checksum dedup ("duplicate" → no skuJson), and
 * skip this write — so re-throwing would strand the product. Operators replay
 * via the emitted `ingestion.spine_catalog_write_failed` audit event.
 */
async function writeSpineExtractionToCatalog(
  deps: IngestionSpineProcessorDeps,
  data: IngestionSpineJobData,
  envelope: IngestionEnvelope,
  result: Awaited<ReturnType<typeof runIngestion>>
): Promise<void> {
  // "duplicate" path carries no skuJson; nothing-extracted leaves it null.
  if (!("skuJson" in result) || result.skuJson == null || !result.artifactId) {
    return;
  }
  const sourceUrl = envelope.sourceExternalId;
  try {
    const channelCode = channelCodeFromUrl(sourceUrl);
    const resolved = await resolveChannelByCode(deps.db, data.tenantId, channelCode);
    await runNewLinkCatalogPath({
      db: deps.db,
      tenantId: data.tenantId,
      merchantId: data.merchantId,
      artifactId: result.artifactId as ArtifactId,
      sourceUrl,
      sku: result.skuJson as SkuJson,
      channelId: resolved?.channelId ?? null,
      channelCode: resolved ? resolved.channelCode : null,
      channelDefaultCurrency: resolved?.defaultCurrency ?? null,
      channelDefaultLocale: resolved?.defaultLocale ?? null,
    });
  } catch (err) {
    await deps.audit.emit({
      tenantId: data.tenantId,
      merchantId: data.merchantId,
      actorType: "worker",
      eventType: "ingestion.spine_catalog_write_failed",
      entityType: "source_artifact",
      entityId: result.artifactId,
      requestId: data.requestId,
      metadata: {
        url: sourceUrl,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
