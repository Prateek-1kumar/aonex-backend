// CSV ingestion path — catalog write. Mirrors new-catalog-shopify-path.ts:
// hands one product group's AdapterOutput to admitOrStage, the single funnel
// into catalog_products / staged_products. CSV products that fail the gate or
// hit an identity conflict are staged to the anomaly lab with sourceKind="csv".

import { admitOrStage, type AdmitOrStageResult } from "@aonex/catalog-service";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import type { ChannelId, MerchantId, TenantId, ArtifactId } from "@aonex/types";
import { schema, type DrizzleClient } from "@aonex/db";

/** Logical channel code carried on CSV observations (matches the adapter default). */
export const CSV_CHANNEL_CODE = "csv";

/**
 * Resolve the per-tenant CSV channel, creating it lazily on first upload.
 * defaultCurrency stays null: CSV rows carry their own `currency` column, so
 * the adapter never needs a channel fallback (the template requires currency
 * whenever a price is set).
 */
export async function resolveOrCreateCsvChannel(
  db: DrizzleClient,
  tenantId: TenantId,
): Promise<{ channelId: ChannelId; defaultCurrency: string | null; defaultLocale: string | null }> {
  const existing = await db.query.channels.findFirst({
    where: (c, { and, eq }) =>
      and(eq(c.tenantId, tenantId), eq(c.channelKind, "csv"), eq(c.accountRef, "csv-upload")),
  });
  if (existing) {
    return {
      channelId: existing.channelId as ChannelId,
      defaultCurrency: existing.defaultCurrency ?? null,
      defaultLocale: existing.defaultLocale ?? null,
    };
  }
  await db.insert(schema.channels).values({
    tenantId,
    channelKind: "csv",
    region: null,
    accountRef: "csv-upload",
    defaultCurrency: null,
    defaultLocale: null,
    displayName: "CSV Upload",
  }).onConflictDoNothing();

  const row = await db.query.channels.findFirst({
    where: (c, { and, eq }) =>
      and(eq(c.tenantId, tenantId), eq(c.channelKind, "csv"), eq(c.accountRef, "csv-upload")),
  });
  if (!row) throw new Error("resolveOrCreateCsvChannel: channel missing after upsert");
  return {
    channelId: row.channelId as ChannelId,
    defaultCurrency: row.defaultCurrency ?? null,
    defaultLocale: row.defaultLocale ?? null,
  };
}

export interface RunNewCsvCatalogPathInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  artifactId: ArtifactId;
  adapterOutput: AdapterOutput;
  /** Optional pre-resolved channel (the processor resolves once per file). */
  channel?: { channelId: ChannelId };
}

export interface RunNewCsvCatalogPathResult {
  outcome: AdmitOrStageResult["outcome"];
  productId: string | null;
  stagedProductId: string | null;
}

export async function runNewCsvCatalogPath(
  input: RunNewCsvCatalogPathInput,
): Promise<RunNewCsvCatalogPathResult> {
  const { db, tenantId, merchantId, artifactId, adapterOutput } = input;
  const channel = input.channel ?? (await resolveOrCreateCsvChannel(db, tenantId));

  const result = await admitOrStage({
    db,
    tenantId,
    merchantId,
    adapterOutput,
    actor: "csv:upload",
    sourceKind: "csv",
    channelCode: CSV_CHANNEL_CODE,
    channelCodeToId: { [CSV_CHANNEL_CODE]: channel.channelId },
    sourceArtifactId: artifactId as string,
  });

  return { outcome: result.outcome, productId: result.productId, stagedProductId: result.stagedProductId };
}
