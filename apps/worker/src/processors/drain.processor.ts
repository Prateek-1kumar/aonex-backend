// nango.drain queue processor — pages records out of the gateway
// and writes them to source_artifacts with checksum-based dedup.
//
// HLD §11: "Persist source_artifacts ... before any processing".
// Phase 2 Field Extractor is enqueued only for newly-inserted rows.
//
// Phase 4 catalog redesign (Task 4.3): when `useNewCatalogSchema` is on AND
// the marketplace is Shopify, every NEWLY-inserted source_artifact is also
// projected into the new catalog tables via `runNewShopifyCatalogPath`. The
// catalog write happens AFTER the source_artifacts insert returns (so the
// raw payload is durable before we try to enrich the catalog from it) and
// runs PER-RECORD with a swallow-and-warn try/catch:
//
//   - Per-record (not batched at end) so one bad payload can't poison a
//     50-page sync; each catalog write is scoped to one artifact.
//   - Swallow-and-warn so drain reliability is preserved: a failed catalog
//     write is recoverable (watchdog or re-drain); a stalled drain is not.

import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import type { Logger } from "pino";
import {
  QUEUE,
  TenantId,
  MerchantId,
  type Marketplace
} from "@aonex/types";
import type { ConnectorAdapterPhase1 } from "@aonex/connector-gateway";
import { schema, type DrizzleClient } from "@aonex/db";
import type { AuditEmitter } from "@aonex/audit";
import type { ShopifyProduct } from "@aonex/catalog-source-adapters";
import { SyncService } from "../services/sync-service.js";
import {
  runNewShopifyCatalogPath,
  SHOPIFY_DEFAULT_REGION,
} from "../services/new-catalog-shopify-path.js";

export interface DrainJobData {
  merchantId: MerchantId;
  tenantId: TenantId;
  marketplace: Marketplace;
  syncJobRunId: string;
  modifiedAfter?: string;
}

export interface DrainProcessorDeps {
  db: DrizzleClient;
  audit: AuditEmitter;
  gateway: ConnectorAdapterPhase1;
  syncService: SyncService;
  /**
   * Phase 4 catalog redesign flag. When TRUE and `marketplace === "shopify"`,
   * each newly-inserted source_artifact is also projected into the new
   * catalog tables. Required at the boundary so callers make the decision
   * explicit.
   */
  useNewCatalogSchema: boolean;
  /**
   * Phase 7 soak dual-write flag. When TRUE and `useNewCatalogSchema` is also
   * TRUE, the processor writes to BOTH the new catalog schema AND the legacy
   * `persistArtifacts` path (so the legacy tables get populated in parallel
   * during the soak window). When FALSE (normal new-schema mode or post-Phase-8
   * cutover), legacy writes are skipped entirely after the new-schema write.
   *
   * Has no effect when `useNewCatalogSchema` is FALSE — the two flags are
   * logically AND-ed. Mirrors the pattern in link-extract.processor.ts.
   */
  useDualWrite: boolean;
  /** Optional pino logger for the catalog dual-path branch. */
  logger?: Logger;
}

export function makeDrainProcessor(deps: DrainProcessorDeps) {
  return async (job: Job<DrainJobData>) => {
    const { merchantId, marketplace, tenantId, syncJobRunId, modifiedAfter } = job.data;

    // Shopify catalog dual-path needs the shop_domain to resolve the channel.
    // Look it up ONCE per drain job — the connection row is stable for the
    // duration of a sync. When the dual path is off OR the marketplace isn't
    // Shopify we skip the lookup entirely.
    let shopDomain: string | null = null;
    if (deps.useNewCatalogSchema && marketplace === "shopify") {
      const conn = await deps.db.query.marketplaceConnections.findFirst({
        where: (c, { and, eq }) =>
          and(eq(c.merchantId, merchantId), eq(c.marketplace, "shopify")),
        columns: { shopDomain: true },
      });
      shopDomain = conn?.shopDomain ?? null;
      if (!shopDomain) {
        deps.logger?.warn(
          { merchantId, tenantId },
          "Shopify dual-path: shop_domain missing on marketplace_connections; catalog projection will skip"
        );
      }
    }

    let totalSeen = 0;
    let totalInserted = 0;

    for await (const page of deps.gateway.drainProducts(
      { merchantId, marketplace },
      { ...(modifiedAfter ? { modifiedAfter: new Date(modifiedAfter) } : {}), pageSize: 100 }
    )) {
      // Extend lock per page (long drains).
      await job.extendLock(job.token!, 60_000);

      totalSeen += page.length;

      // ── Phase 8 cutover gate ─────────────────────────────────────────────
      // When useNewCatalogSchema=true AND useDualWrite=false (post-cutover),
      // we skip persistArtifacts (legacy path) entirely and write only to the
      // new catalog. The new-schema path runs FIRST so that if it throws the
      // drain is retried clean (no partial legacy write was committed).
      //
      // When useDualWrite=true (Phase 7 soak window), both paths run so the
      // legacy tables stay populated for parity checks.
      //
      // When useNewCatalogSchema=false, neither new-schema branch is entered —
      // only the legacy persistArtifacts runs (original pre-Phase-4 behavior).
      //
      // Mirrors the branching pattern in link-extract.processor.ts.

      // Track whether the new-schema block already counted this page's inserts.
      // When true, the legacy path's count is skipped to avoid double-counting.
      // When false (new-schema skipped, or dual-write ON), legacy is authoritative.
      let countedByNewSchema = false;

      if (
        deps.useNewCatalogSchema &&
        marketplace === "shopify" &&
        shopDomain
      ) {
        // --- New-schema path (runs first, always, when flag ON + Shopify) ---
        // We need the source_artifact ids to pass to runNewShopifyCatalogPath.
        // When useDualWrite=false we run persistArtifacts solely to get the
        // artifact rows (dedup logic lives there), then skip the legacy catalog
        // write below. When useDualWrite=true we fall through to the legacy
        // persistArtifacts block so it updates syncJobRuns as usual.
        const { inserted: insertedArtifacts } = await deps.syncService.persistArtifacts({
          tenantId,
          merchantId,
          marketplace,
          syncJobRunId,
          records: page.map((r) => ({
            externalId: r.externalId,
            raw: r.raw,
            ...(r.modifiedAt ? { modifiedAt: r.modifiedAt } : {})
          }))
        });

        totalInserted += insertedArtifacts.length;

        // Per-record new-catalog write (swallow-and-warn per file-header rationale).
        for (const artifact of insertedArtifacts) {
          try {
            const shopifyArgs: Parameters<typeof runNewShopifyCatalogPath>[0] = {
              db: deps.db,
              tenantId,
              merchantId,
              artifactId: artifact.artifactId,
              shopDomain,
              region: SHOPIFY_DEFAULT_REGION,
              shopifyProduct: artifact.raw as ShopifyProduct,
              observedAt: artifact.modifiedAt ?? new Date(),
            };
            if (deps.logger) shopifyArgs.logger = deps.logger;
            await runNewShopifyCatalogPath(shopifyArgs);
          } catch (err) {
            deps.logger?.warn(
              {
                err,
                artifactId: artifact.artifactId,
                externalId: artifact.externalId,
                merchantId,
                tenantId,
              },
              "shopify.new_catalog.failed"
            );
          }
        }

        // Post-cutover (useDualWrite=false): skip legacy catalog writes entirely.
        // The new-schema block already counted the inserts; mark so the legacy
        // path below does not double-count.
        if (!deps.useDualWrite) {
          countedByNewSchema = true;
          continue;
        }

        // Dual-write: fall through to legacy persistArtifacts below (it will
        // dedup on checksum, so the re-insert is a no-op for rows we just
        // inserted above — the counts are already correct in totalInserted).
        // Legacy path does NOT re-count (countedByNewSchema stays false here
        // because we want the legacy path to be the authoritative count in
        // dual-write mode — the new-schema count above may differ from legacy
        // due to checksum dedup on the re-insert).
        //
        // Reset totalInserted contribution from above: in dual-write mode the
        // legacy persistArtifacts is the canonical insert path; its count is used.
        totalInserted -= insertedArtifacts.length;
      }

      // ── Legacy path ──────────────────────────────────────────────────────
      // Runs when:
      //   (a) useNewCatalogSchema=false (original behavior), OR
      //   (b) useNewCatalogSchema=true AND useDualWrite=true (Phase 7 soak), OR
      //   (c) useNewCatalogSchema=true AND non-Shopify or missing shopDomain.
      // In case (b) the new-schema branch above already called persistArtifacts
      // and the re-insert below is a no-op (checksum dedup). We accept the
      // extra round-trip to keep the branching logic simple and symmetric
      // with link-extract.processor.ts.
      // In case (c) — non-Shopify marketplace — the legacy path is the only
      // write, and its count MUST be recorded so syncJobRuns.records_added
      // is correct for ebay/amazon/etc drains.
      const { inserted: legacyInserted } = await deps.syncService.persistArtifacts({
        tenantId,
        merchantId,
        marketplace,
        syncJobRunId,
        records: page.map((r) => ({
          externalId: r.externalId,
          raw: r.raw,
          ...(r.modifiedAt ? { modifiedAt: r.modifiedAt } : {})
        }))
      });

      // Count legacy inserts UNLESS the new-schema block already counted them
      // and skipped the legacy path (countedByNewSchema=true, set only when
      // useDualWrite=false after a successful new-schema write). This guards:
      //   - Non-Shopify drains with flag ON: new-schema block never ran →
      //     countedByNewSchema=false → legacy count is used (correct).
      //   - Dual-write (Shopify, flag ON): countedByNewSchema stays false →
      //     legacy count is used (canonical, no double-count).
      //   - Flag OFF: countedByNewSchema=false → legacy count is used.
      if (!countedByNewSchema) {
        totalInserted += legacyInserted.length;
      }
    }

    await deps.db
      .update(schema.syncJobRuns)
      .set({ completedAt: new Date(), recordsAdded: totalInserted })
      .where(eq(schema.syncJobRuns.id, syncJobRunId));

    await deps.audit.emit({
      tenantId,
      merchantId,
      actorType: "worker",
      eventType: "sync.drain_completed",
      entityType: "sync_job_run",
      entityId: syncJobRunId,
      metadata: { totalSeen, totalInserted, marketplace }
    });
  };
}

export const PROCESSOR_QUEUE = QUEUE.NANGO_DRAIN;
