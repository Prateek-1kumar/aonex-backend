// SyncService — source_artifacts persistence with checksum dedup.
// Extracted from drain.processor.ts so processors and future direct
// callers share one implementation. Idempotent: ON CONFLICT DO NOTHING
// on (merchantId, sourceMarketplace, sourceExternalId, checksum).

import { schema, type DrizzleClient } from '@aonex/db';
import type { Queue } from 'bullmq';
import {
  JOB_KIND,
  STANDARD_RETRY,
  type ArtifactId,
  type MerchantId,
  type TenantId,
  type Marketplace
} from '@aonex/types';
import { canonicalStringify, sha256Hex } from '@aonex/lib-utils';

export interface ProviderProductRecord {
  externalId: string;
  raw: unknown;
  modifiedAt?: Date;
}

export interface PersistArtifactsInput {
  tenantId: TenantId;
  merchantId: MerchantId;
  marketplace: Marketplace;
  syncJobRunId: string;
  records: ProviderProductRecord[];
}

/**
 * Detail of a single artifact that was newly inserted (i.e. NOT a
 * checksum-dedup hit). Returned per-record so the drain processor can
 * dispatch downstream side-effects (new catalog projection in Phase 4,
 * extract queue enqueue is handled inline below) keyed on the same
 * `artifactId` that landed in `source_artifacts`.
 */
export interface InsertedArtifact {
  artifactId: ArtifactId;
  externalId: string;
  raw: unknown;
  modifiedAt?: Date;
}

export interface PersistArtifactsResult {
  /** Per-record details for NEWLY inserted artifacts (dedup hits omitted). */
  inserted: InsertedArtifact[];
}

export interface SyncServiceDeps {
  db: DrizzleClient;
  extractQueue: Queue;
}

export class SyncService {
  constructor(private readonly deps: SyncServiceDeps) {}

  async persistArtifacts(input: PersistArtifactsInput): Promise<PersistArtifactsResult> {
    const inserted: InsertedArtifact[] = [];
    for (const record of input.records) {
      const checksum = sha256Hex(canonicalStringify(record.raw));
      const rows = await this.deps.db
        .insert(schema.sourceArtifacts)
        .values({
          tenantId: input.tenantId,
          merchantId: input.merchantId,
          sourceType: 'marketplace_connector',
          sourceMarketplace: input.marketplace,
          sourceExternalId: record.externalId,
          rawData: record.raw as Record<string, unknown>,
          checksum,
          status: 'pending',
          syncJobRunId: input.syncJobRunId,
          ...(record.modifiedAt ? { modifiedAt: record.modifiedAt } : {})
        })
        .onConflictDoNothing({
          target: [
            schema.sourceArtifacts.merchantId,
            schema.sourceArtifacts.sourceMarketplace,
            schema.sourceArtifacts.sourceExternalId,
            schema.sourceArtifacts.checksum
          ]
        })
        .returning({ id: schema.sourceArtifacts.id });

      if (rows.length > 0) {
        const artifactId = rows[0]!.id as ArtifactId;
        inserted.push({
          artifactId,
          externalId: record.externalId,
          raw: record.raw,
          ...(record.modifiedAt ? { modifiedAt: record.modifiedAt } : {})
        });
        await this.deps.extractQueue.add(
          JOB_KIND.EXTRACT,
          { artifactId },
          { jobId: `extract:${artifactId}`, ...STANDARD_RETRY }
        );
      }
    }
    return { inserted };
  }
}
