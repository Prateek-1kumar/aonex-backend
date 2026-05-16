import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId, ArtifactId } from "@aonex/types";
import type { IngestionEnvelope } from "../adapter.js";

export interface PersistArtifactInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  envelope: IngestionEnvelope;
}

export interface PersistArtifactResult {
  /** null when checksum already existed (dedup) */
  artifactId: ArtifactId | null;
  /** populated when artifactId is null */
  duplicateOfChecksum: string | null;
}

/**
 * Spec §5.2 — first stage of the unified spine. Persists the raw envelope
 * to source_artifacts BEFORE any extraction. Checksum-based dedup via the
 * existing UNIQUE(merchant_id, source_marketplace, source_external_id, checksum)
 * index.
 */
export async function persistArtifact(
  input: PersistArtifactInput
): Promise<PersistArtifactResult> {
  const [row] = await input.db
    .insert(schema.sourceArtifacts)
    .values({
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      sourceType: input.envelope.sourceType,
      sourceMarketplace: input.envelope.sourceMarketplace,
      sourceExternalId: input.envelope.sourceExternalId,
      rawData: input.envelope.rawData,
      checksum: input.envelope.checksum,
      storageUri: input.envelope.storageUri ?? null,
      parentArtifactId: input.envelope.parentArtifactId ?? null,
      status: "processing"
    })
    .onConflictDoNothing()
    .returning({ id: schema.sourceArtifacts.id });

  if (!row) {
    return { artifactId: null, duplicateOfChecksum: input.envelope.checksum };
  }
  return { artifactId: row.id as ArtifactId, duplicateOfChecksum: null };
}
