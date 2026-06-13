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
import { getAdapter, channelCodeFromUrl } from "@aonex/catalog-source-adapters";
import type { AdaptContext } from "@aonex/catalog-source-adapters";
import type { SkuJson } from "@aonex/ingestion-enrichment";
import type {
  ArtifactId,
  ChannelId,
  MerchantId,
  TenantId,
} from "@aonex/types";
import { schema, type DrizzleClient } from "@aonex/db";
import { eq, isNotNull } from "drizzle-orm";
import type { Queue } from "bullmq";

/**
 * Load the attribute vocabulary (canonical definitions + approved synonyms)
 * the link adapter uses to resolve raw extraction keys to canonical codes vs
 * `custom.<slug>` (Faithful Catalog §3). Only `active` definitions and approved
 * synonyms participate so candidate/deprecated rows can't silently steer
 * mapping. Mapped to the source-adapter framework's lean shapes.
 *
 * v1 loads per-ingest (the corpus is small — tens of rows). TODO(perf): cache
 * with a short TTL keyed by a registry version if the corpus grows.
 */
async function loadAttributeVocabulary(
  db: DrizzleClient
): Promise<Pick<AdaptContext, "attributeDefinitions" | "attributeSynonyms">> {
  const defs = await db
    .select({
      canonicalKey: schema.attributeDefinitions.canonicalKey,
      canonicalUnit: schema.attributeDefinitions.canonicalUnit,
      dataType: schema.attributeDefinitions.dataType,
    })
    .from(schema.attributeDefinitions)
    .where(eq(schema.attributeDefinitions.status, "active"));

  const syns = await db
    .select({
      canonicalKey: schema.attributeSynonyms.canonicalKey,
      synonym: schema.attributeSynonyms.synonym,
      sourceMarketplace: schema.attributeSynonyms.sourceMarketplace,
    })
    .from(schema.attributeSynonyms)
    .where(isNotNull(schema.attributeSynonyms.approvedAt));

  return {
    attributeDefinitions: defs.map((d) => ({
      canonicalKey: d.canonicalKey,
      canonicalUnit: d.canonicalUnit ?? null,
      dataType: d.dataType,
      // reconciliationPath is unused by the key resolver; default it. The
      // catalog write service selects the real tier from attribute metadata.
      reconciliationPath: "sync" as const,
    })),
    attributeSynonyms: syns.map((s) => ({
      canonicalKey: s.canonicalKey,
      synonym: s.synonym,
      sourceMarketplace: s.sourceMarketplace ?? null,
    })),
  };
}

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

/**
 * Resolve (or lazily create) a per-host "direct" channel for link products that
 * don't map to a known marketplace. Link ingests of arbitrary brand sites
 * (decathlon.in, wakefit.co) have no marketplace channel, so without this their
 * page price is stripped and they stage on missing pricing. Attributing the
 * price to a 'direct' channel (one per host, keyed by region=channelCode) lets
 * the product admit with its web price. Idempotent via uq_channels.
 */
export async function resolveOrCreateDirectChannel(
  db: DrizzleClient,
  tenantId: TenantId,
  channelCode: string
): Promise<{
  channelId: ChannelId;
  channelCode: string;
  defaultCurrency: string | null;
  defaultLocale: string | null;
}> {
  const find = () =>
    db.query.channels.findFirst({
      where: (c, { and, eq }) =>
        and(eq(c.tenantId, tenantId), eq(c.channelKind, "direct"), eq(c.region, channelCode)),
    });
  let row = await find();
  if (!row) {
    await db
      .insert(schema.channels)
      .values({ tenantId, channelKind: "direct", region: channelCode, displayName: channelCode })
      .onConflictDoNothing();
    row = await find();
  }
  if (!row) throw new Error(`resolveOrCreateDirectChannel: no channel after insert for ${channelCode}`);
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
  /** Canonical taxonomy node resolved at ingestion; persisted on admit/stage. */
  categoryNodeId?: string | null;
  /** Observed-at for the adapter envelope. Defaults to now() — exposed for tests. */
  observedAt?: Date;
  /** Per-tenant reconcile queue; forwarded to admitOrStage for post-commit pricing/inventory reconcile. Optional. */
  reconcilerQueue?: Queue;
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
    categoryNodeId = null,
    observedAt = new Date(),
    reconcilerQueue,
  } = input;

  const adapter = getAdapter("link");

  // Channel resolution. Marketplace URLs resolve to a configured channel.
  // Channel-less link products (arbitrary brand sites) are attributed to a
  // per-host 'direct' channel so the page price is KEPT and the product admits
  // with its web price instead of staging on missing pricing (product decision:
  // "admit with the page price"). The adapter emits observations under
  // channelCodeFromUrl(sourceUrl), so the channelCodeToId map keys on that.
  const urlChannelCode = channelCodeFromUrl(sourceUrl);
  const marketplaceResolved = channelId !== null && channelCode !== null;
  let effChannelId: ChannelId;
  let effCurrency = channelDefaultCurrency;
  let effLocale = channelDefaultLocale;
  if (marketplaceResolved) {
    effChannelId = channelId;
  } else {
    const direct = await resolveOrCreateDirectChannel(db, tenantId, urlChannelCode);
    effChannelId = direct.channelId;
    effCurrency = direct.defaultCurrency;
    effLocale = direct.defaultLocale;
  }

  // Bridge: the readiness gate requires a non-empty `category_path`, but
  // extraction doesn't always yield one (e.g. a flannel shirt with no source
  // breadcrumb). When the spine resolved a taxonomy node, use it as the
  // category_path so a categorized product ADMITS instead of staging on a
  // missing free-text category. The canonical category_node_id is still set
  // separately on the row.
  const skuWithCategory =
    categoryNodeId && !sku.category_path ? { ...sku, category_path: categoryNodeId } : sku;

  // A price WITHOUT a currency cannot be emitted as a channel-scoped
  // observation (the adapter throws). Strip just the pricing in that rare case
  // so the catalog_products row, revision, and outbox event still land.
  const priceMissingCurrency =
    (sku.pricing.list_price !== null || sku.pricing.sale_price !== null) &&
    (sku.pricing.currency === null || sku.pricing.currency === "");
  const adapterSku = priceMissingCurrency
    ? stripChannelScopedSkuData(skuWithCategory)
    : skuWithCategory;
  if (priceMissingCurrency) {
    console.warn(
      `[new-catalog-link-path] price without currency for sourceUrl=${sourceUrl}; dropping pricing`
    );
  }

  // Load the attribute vocabulary so the adapter resolves raw extraction keys
  // to canonical codes (recognized) or `custom.<slug>` (unrecognized) instead
  // of dumping raw page keys into the catalog as first-class attributes.
  const vocabulary = await loadAttributeVocabulary(db);

  const adapterOutput = adapter.adapt(
    { sku: adapterSku, sourceUrl, observedAt, artifactId },
    {
      tenantId,
      channelId: effChannelId,
      channelDefaultCurrency: effCurrency,
      channelDefaultLocale: effLocale,
      ...vocabulary,
    }
  );

  return admitOrStage({
    db,
    tenantId,
    merchantId,
    adapterOutput,
    actor: "link:processor",
    sourceKind: "link",
    ...(categoryNodeId ? { categoryNodeId } : {}),
    channelCode: urlChannelCode,
    channelCodeToId: { [urlChannelCode]: effChannelId },
    sourceArtifactId: artifactId as string,
    ...(reconcilerQueue !== undefined ? { reconcilerQueue } : {}),
  });
}
