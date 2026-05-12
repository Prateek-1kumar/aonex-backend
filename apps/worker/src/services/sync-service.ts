// SyncService — source_artifacts persistence with checksum dedup.
// Extracted from drain.processor.ts so processors and future direct
// callers share one implementation. Idempotent: ON CONFLICT DO NOTHING
// on (merchantId, sourceMarketplace, sourceExternalId, checksum).

import { schema, type DrizzleClient } from '@aonex/db';
import type { Queue } from 'bullmq';
import { JOB_KIND, STANDARD_RETRY, type MerchantId, type TenantId, type Marketplace } from '@aonex/types';
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

export interface SyncServiceDeps {
  db: DrizzleClient;
  extractQueue: Queue;
}

export class SyncService {
  constructor(private readonly deps: SyncServiceDeps) {}

  async persistArtifacts(input: PersistArtifactsInput): Promise<{ inserted: number }> {
    let inserted = 0;
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
        inserted += 1;
        await this.deps.extractQueue.add(
          JOB_KIND.EXTRACT,
          { artifactId: rows[0]!.id },
          { jobId: `extract:${rows[0]!.id}`, ...STANDARD_RETRY }
        );
      }
    }
    return { inserted };
  }
}
