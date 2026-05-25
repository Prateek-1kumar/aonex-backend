// Link ingestion path — catalog write (Task 4.2).
//
// Responsibilities:
//   1. Resolve the channel row for a given URL via `resolveChannelByCode`
//      (allow-list of known marketplace kinds + tenant lookup).
//   2. Wrap an LLM-extracted SkuJson into a LinkAdapterInput envelope.
//   3. Call the `link` source adapter to produce CanonicalObservations +
//      pricing / inventory observations + identity hint.
//   4. Hand the AdapterOutput to `writeAdapterOutput`, which is the single
//      transactional funnel into catalog_products + side tables + revisions
//      + outbox events.
//
// Channel resolution: callers invoke `resolveChannelByCode(db, tenantId, code)`
// which returns null for unknown marketplaces (anything outside the curated
// allow-list, or any allow-listed kind with no tenant row). When the channel
// is null, we deliberately pre-strip `sku.pricing` and per-variant pricing
// from the SkuJson BEFORE calling the adapter, so the adapter never sees
// channel-scoped data and never throws on missing currency. The
// catalog_products row, revision, and outbox event still land so the URL
// isn't silently lost. Bootstrap of new channel rows happens out-of-band via
// `scripts/bootstrap-channels.ts`; we do NOT auto-create here.

import { admitOrStage, type AdmitOrStageResult } from "@aonex/catalog-service";
import { getAdapter } from "@aonex/catalog-source-adapters";
import type { SkuJson } from "@aonex/ingestion-enrichment";
import type {
  ArtifactId,
  ChannelId,
  MerchantId,
  TenantId,
} from "@aonex/types";
import type { DrizzleClient } from "@aonex/db";
import { PLACEHOLDER_CHANNEL_ID } from "./_internal.js";

/**
 * Curated allow-list of canonical marketplace channel-kinds. The link
 * adapter's `channelCodeFromUrl` can emit arbitrary host-derived codes
 * (e.g. "myshop-example-io") whose prefix is NOT a real marketplace —
 * matching those against `channels.channel_kind` would silently bind
 * unrelated URLs to a tenant's real channel rows. Only codes whose prefix
 * falls in this set are looked up; anything else returns null
 * ("channel unresolved") so the strip-and-warn branch fires.
 *
 * Phase 5 will replace this with an explicit channel-resolver service
 * backed by `channels` + per-tenant marketplace registration.
 */
const KNOWN_CHANNEL_KINDS: ReadonlySet<string> = new Set([
  "amazon",
  "ebay",
  "flipkart",
  "shopify",
  "walmart",
  "myntra",
  "kmart",
  "bunnings",
  "jbhifi",
  "catch",
  "woolworths",
]);

/**
 * Look up the channel row for a tenant + channel-code (as emitted by
 * `channelCodeFromUrl`). Returns null when:
 *   - the code's prefix is not in `KNOWN_CHANNEL_KINDS`, OR
 *   - the tenant has no row for that channelKind.
 *
 * Encapsulating the allow-list + DB lookup here (rather than inlining in
 * the processor) keeps the trust boundary in one place and lets tests
 * exercise both branches without dragging in the rest of the pipeline.
 */
export async function resolveChannelByCode(
  db: DrizzleClient,
  tenantId: TenantId,
  channelCode: string
): Promise<{
  channelId: ChannelId;
  channelCode: string;
  defaultCurrency: string | null;
  defaultLocale: string | null;
} | null> {
  const derivedKind = channelCode.split("-")[0] ?? "";
  if (!KNOWN_CHANNEL_KINDS.has(derivedKind)) return null;

  const row = await db.query.channels.findFirst({
    where: (c, { and, eq }) =>
      and(eq(c.tenantId, tenantId), eq(c.channelKind, derivedKind)),
  });
  if (!row) return null;

  return {
    channelId: row.channelId as ChannelId,
    channelCode,
    defaultCurrency: row.defaultCurrency ?? null,
    defaultLocale: row.defaultLocale ?? null,
  };
}

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
 * Pre-strip pricing + inventory data from a SkuJson envelope. Used when
 * the channel is unresolved — feeds the adapter a sanitized SkuJson so it
 * never emits PricingObservations / InventoryObservations and never throws
 * on missing currency (`linkAdapter: pricing currency missing...`).
 *
 * Both parent-level `pricing` and per-variant `pricing` fields are zeroed
 * (set to all-null) — keeping the SkuJson shape intact rather than deleting
 * keys, so the adapter's null-checks still see a well-formed object.
 */
function stripChannelScopedSkuData(sku: SkuJson): SkuJson {
  const nullPricing = {
    list_price: null,
    sale_price: null,
    currency: null,
    discount_percent: null,
    price_per_unit: null,
  };
  const nullVariantPricing = {
    list_price: null,
    sale_price: null,
    currency: null,
  };
  return {
    ...sku,
    pricing: nullPricing,
    variants: sku.variants.map((v) => ({
      ...v,
      pricing: nullVariantPricing,
    })),
  };
}

export async function runNewLinkCatalogPath(
  input: RunNewLinkCatalogPathInput
): Promise<AdmitOrStageResult> {
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
  const channelResolved = channelId !== null && channelCode !== null;

  // Unknown-channel safety net: feed the adapter a SkuJson with pricing +
  // variant pricing zeroed BEFORE it runs, so the adapter never emits
  // channel-scoped observations and never throws on missing currency. The
  // catalog_products row, revision, and outbox event still land. We log a
  // warning if the original SkuJson actually had pricing data so the drop
  // is observable.
  const adapterSku = channelResolved ? sku : stripChannelScopedSkuData(sku);
  if (!channelResolved) {
    const droppedParentPricing =
      sku.pricing.list_price !== null || sku.pricing.sale_price !== null
        ? 1
        : 0;
    const droppedVariantPricing = sku.variants.filter(
      (v) => v.pricing.list_price !== null || v.pricing.sale_price !== null
    ).length;
    if (droppedParentPricing + droppedVariantPricing > 0) {
      // TODO(catalog-redesign-cleanup): plumb the drain/processor pino logger
      // here, mirroring the `PathLogger` pattern in new-catalog-shopify-path.ts.
      // Lightweight stderr warning for now — the processor's audit emitter
      // records the success path.
      // eslint-disable-next-line no-console
      console.warn(
        `[new-catalog-link-path] channel unresolved for sourceUrl=${sourceUrl}; dropping ${droppedParentPricing} parent + ${droppedVariantPricing} variant pricing entries`
      );
    }
  }

  // The adapter REQUIRES a non-empty ChannelId in its AdaptContext even
  // when we don't have one (the link adapter does not actually persist
  // this id — see source-adapters/src/link/index.ts). With pricing
  // pre-stripped above, the placeholder only appears on parent-level
  // CanonicalObservations that aren't bound to a real channel row.
  const adapterOutput = adapter.adapt(
    { sku: adapterSku, sourceUrl, observedAt, artifactId },
    {
      tenantId,
      channelId: channelId ?? PLACEHOLDER_CHANNEL_ID,
      channelDefaultCurrency,
      channelDefaultLocale,
      // Phase 4 v1: empty arrays — adapters fall back to default rules.
      // Phase 5+ will load real definitions / synonyms from
      // `attribute_definitions` + `attribute_synonyms`.
      attributeDefinitions: [],
      attributeSynonyms: [],
    }
  );

  return admitOrStage({
    db,
    tenantId,
    merchantId,
    adapterOutput,
    actor: "link:processor",
    sourceKind: "link",
    channelCode: channelResolved ? channelCode : null,
    ...(channelResolved && channelCode !== null && channelId !== null
      ? { channelCodeToId: { [channelCode]: channelId } }
      : {}),
    sourceArtifactId: artifactId as unknown as string,
  });
}
