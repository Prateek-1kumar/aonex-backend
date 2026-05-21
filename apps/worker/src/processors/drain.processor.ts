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
   * catalog tables. Required — the composition root always supplies it;
   * tests must pass `false` (or `true`) explicitly to keep the trust
   * boundary tight.
   */
  useNewCatalogSchema: boolean;
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

      const { inserted } = await deps.syncService.persistArtifacts({
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

      totalSeen += page.length;
      totalInserted += inserted.length;

      // Phase 4 catalog dual-path. Per-record loop so one failure doesn't
      // poison the rest of the batch. Errors are LOGGED, not thrown —
      // see file-header comment for the rationale.
      if (
        deps.useNewCatalogSchema &&
        marketplace === "shopify" &&
        shopDomain &&
        inserted.length > 0
      ) {
        for (const artifact of inserted) {
          try {
            await runNewShopifyCatalogPath({
              db: deps.db,
              tenantId,
              merchantId,
              artifactId: artifact.artifactId,
              shopDomain,
              region: SHOPIFY_DEFAULT_REGION,
              shopifyProduct: artifact.raw as ShopifyProduct,
              observedAt: artifact.modifiedAt ?? new Date(),
            });
          } catch (err) {
            deps.logger?.warn(
              {
                err,
                artifactId: artifact.artifactId,
                externalId: artifact.externalId,
                merchantId,
                tenantId,
              },
              "Shopify catalog dual-path write failed (drain continues)"
            );
          }
        }
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
