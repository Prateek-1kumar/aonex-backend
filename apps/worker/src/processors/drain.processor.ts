// nango.drain queue processor — pages records out of the gateway
// and writes them to source_artifacts with checksum-based dedup.
//
// HLD §11: "Persist source_artifacts ... before any processing".
// Phase 2 Field Extractor is enqueued only for newly-inserted rows.
//
// For Shopify drains, each newly-inserted source_artifact is also projected
// into the new catalog tables via `runNewShopifyCatalogPath`. The catalog
// write happens AFTER the source_artifacts insert returns (raw payload is
// durable before enrichment) and runs PER-RECORD with swallow-and-warn:
//
//   - Per-record so one bad payload can't poison a 50-page sync.
//   - Swallow-and-warn so drain reliability is preserved — a failed catalog
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
  /** Optional pino logger for the Shopify catalog write branch. */
  logger?: Logger;
}

export function makeDrainProcessor(deps: DrainProcessorDeps) {
  return async (job: Job<DrainJobData>) => {
    const { merchantId, marketplace, tenantId, syncJobRunId, modifiedAfter } = job.data;

    // Look up shop_domain once per drain job for the Shopify catalog write path.
    let shopDomain: string | null = null;
    if (marketplace === "shopify") {
      const conn = await deps.db.query.marketplaceConnections.findFirst({
        where: (c, { and, eq }) =>
          and(eq(c.merchantId, merchantId), eq(c.marketplace, "shopify")),
        columns: { shopDomain: true },
      });
      shopDomain = conn?.shopDomain ?? null;
      if (!shopDomain) {
        deps.logger?.warn(
          { merchantId, tenantId },
          "Shopify catalog write: shop_domain missing on marketplace_connections; catalog projection will skip"
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

      // Persist artifacts (checksum-based dedup lives inside persistArtifacts).
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

      // Shopify catalog write — per-record, swallow-and-warn (drain reliability).
      if (marketplace === "shopify" && shopDomain) {
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
