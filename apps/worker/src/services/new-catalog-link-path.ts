// New-schema link ingestion path (Task 4.2).
//
// Runs ONLY when `useNewCatalogSchema` is on. The legacy path
// (`persistLinkCatalogPipeline`) is gated separately in the processor.
//
// Responsibilities:
//   1. Wrap an LLM-extracted SkuJson into a LinkAdapterInput envelope.
//   2. Call the `link` source adapter to produce CanonicalObservations +
//      pricing / inventory observations + identity hint.
//   3. Hand the AdapterOutput to `writeAdapterOutput`, which is the single
//      transactional funnel into catalog_products + side tables + revisions
//      + outbox events.
//
// Channel resolution lives in the CALLER (processor). When the caller cannot
// resolve a channel for the incoming URL (unknown marketplace, no row in
// `channels`), we deliberately DROP pricing + inventory observations from
// the adapter output before writing — the catalog_products row, revision,
// and outbox event still land so the URL isn't silently lost. Logged as a
// warning. Bootstrap of new channel rows happens out-of-band via
// `scripts/bootstrap-channels.ts`; we do NOT auto-create here.

import { writeAdapterOutput, type WriteAdapterOutputResult } from "@aonex/catalog-service";
import { getAdapter, type AdapterOutput } from "@aonex/catalog-source-adapters";
import type { SkuJson } from "@aonex/ingestion-enrichment";
import type {
  ArtifactId,
  ChannelId,
  MerchantId,
  TenantId,
} from "@aonex/types";
import type { DrizzleClient } from "@aonex/db";

export interface RunNewLinkCatalogPathInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  artifactId: ArtifactId;
  sourceUrl: string;
  sku: SkuJson;
  /**
   * Channel resolved from `(tenantId, channelKind, region)` by the caller.
   * NULL when no matching channel row exists for this URL host — in that
   * case pricing + inventory side-table inserts are skipped (logged), but
   * the catalog_products write itself still proceeds.
   */
  channelId: ChannelId | null;
  /** Channel code as emitted by `channelCodeFromUrl(sourceUrl)`. Same null-when-unresolved semantics as channelId. */
  channelCode: string | null;
  channelDefaultCurrency: string | null;
  channelDefaultLocale: string | null;
  /** Observed-at for the adapter envelope. Defaults to now() — exposed for tests. */
  observedAt?: Date;
}

/**
 * Drop pricing + inventory observations from an AdapterOutput. Used when
 * we can't resolve a channel — writeAdapterOutput would otherwise throw
 * for missing channelCodeToId.
 */
function stripChannelScopedObservations(out: AdapterOutput): AdapterOutput {
  return {
    ...out,
    pricingObservations: [],
    inventoryObservations: [],
  };
}

export async function runNewLinkCatalogPath(
  input: RunNewLinkCatalogPathInput
): Promise<WriteAdapterOutputResult> {
  const {
    db,
    tenantId,
    merchantId,
    artifactId,
    sourceUrl,
    sku,
    channelId,
    channelCode,
    channelDefaultCurrency,
    channelDefaultLocale,
    observedAt = new Date(),
  } = input;

  const adapter = getAdapter("link");

  // The adapter REQUIRES a non-empty ChannelId in its AdaptContext even
  // when we don't have one (used only as a tag on observations downstream
  // for some adapters; the link adapter does not actually persist this id
  // — see source-adapters/src/link/index.ts). Pass a sentinel zero-UUID when
  // unresolved so the type stays satisfied.
  const placeholderChannelId =
    "00000000-0000-0000-0000-000000000000" as unknown as ChannelId;

  const adapterOutput = adapter.adapt(
    { sku, sourceUrl, observedAt, artifactId },
    {
      tenantId,
      channelId: channelId ?? placeholderChannelId,
      channelDefaultCurrency,
      channelDefaultLocale,
      // Phase 4 v1: empty arrays — adapters fall back to default rules.
      // Phase 5+ will load real definitions / synonyms from
      // `attribute_definitions` + `attribute_synonyms`.
      attributeDefinitions: [],
      attributeSynonyms: [],
    }
  );

  // Unknown-channel safety net: strip pricing + inventory observations so
  // writeAdapterOutput's precondition (channelCodeToId required iff side-
  // table observations present) is satisfied. The product row + revision +
  // outbox event still land.
  const outputToWrite =
    channelId === null || channelCode === null
      ? stripChannelScopedObservations(adapterOutput)
      : adapterOutput;

  if (
    outputToWrite !== adapterOutput &&
    (adapterOutput.pricingObservations.length > 0 ||
      adapterOutput.inventoryObservations.length > 0)
  ) {
    // Lightweight stderr warning — we don't pull a logger dep into this
    // module. The processor's audit emitter still records the success path.
    // eslint-disable-next-line no-console
    console.warn(
      `[new-catalog-link-path] channel unresolved for sourceUrl=${sourceUrl}; dropping ${adapterOutput.pricingObservations.length} pricing + ${adapterOutput.inventoryObservations.length} inventory observations`
    );
  }

  const writeInput: Parameters<typeof writeAdapterOutput>[0] = {
    db,
    tenantId,
    merchantId,
    adapterOutput: outputToWrite,
    actor: "link-extract",
    rulesVersion: 1,
  };
  if (channelId !== null && channelCode !== null) {
    writeInput.channelCodeToId = { [channelCode]: channelId };
  }

  return writeAdapterOutput(writeInput);
}
