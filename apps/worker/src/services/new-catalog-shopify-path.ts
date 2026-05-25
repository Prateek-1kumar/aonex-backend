// Shopify ingestion path — catalog write (Task 4.3).
//
// The Nango → drain →
// `source_artifacts` write is the system of record for the raw payload; this
// helper is invoked for each NEWLY-inserted artifact (i.e. not a checksum
// dedup hit) to project that payload into the new catalog tables.
//
// Responsibilities:
//   1. Resolve the channel row for `(tenantId, channelKind='shopify',
//      region, accountRef=shopDomain)` via `resolveShopifyChannel`.
//      Channel lookup is keyed by shop_domain matching the bootstrap-channels
//      convention (Task 1.12).
//   2. Wrap the raw ShopifyProduct in a `ShopifyAdapterInput` envelope and
//      call the `shopify-connector` adapter to produce CanonicalObservations
//      + pricing / inventory observations + an identity hint (variant-level
//      GTINs land in the identityHint so existing products attach correctly).
//   3. Hand the AdapterOutput to `writeAdapterOutput`, the single
//      transactional funnel into catalog_products + side tables + revisions
//      + outbox events.
//
// Channel resolution: when the channel row doesn't exist for this tenant +
// shop_domain combo we strip pricing AND inventory observations from the
// AdapterOutput before writing — the catalog_products row, revision and
// outbox event still land so the product isn't silently lost. Channel rows
// are bootstrapped out-of-band via `scripts/bootstrap-channels.ts` (Task
// 1.12); we do NOT auto-create here.
//
// Error policy (drain reliability): callers (drain.processor.ts) wrap this
// in a try/catch that LOGS-AND-CONTINUES on failure. Rationale: the drain
// MUST stay reliable — one bad product shouldn't poison a 50-page sync
// run. A failed catalog write is recoverable by the watchdog or by a
// one-off re-drain; a failed `source_artifacts` insert is not.

import { admitOrStage, type AdmitOrStageResult } from "@aonex/catalog-service";
import {
  getAdapter,
  channelCodeFromShopDomain,
  type ShopifyAdapterInput,
  type ShopifyProduct,
} from "@aonex/catalog-source-adapters";
import type {
  ArtifactId,
  ChannelId,
  MerchantId,
  TenantId,
} from "@aonex/types";
import type { DrizzleClient } from "@aonex/db";
import { sql } from "drizzle-orm";
import { PLACEHOLDER_CHANNEL_ID } from "./_internal.js";

/**
 * Minimal structural logger type — kept local so this module doesn't pull in
 * `pino` as a direct dependency. Both pino's `Logger` and any
 * `{ warn(obj, msg) }` shape conform.
 */
export interface PathLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Default region for Shopify channels — mirrors the bootstrap-channels script
 * (Task 1.12). `*.myshopify.com` hostnames don't carry a region signal; the
 * bootstrap defaults to 'AU' (primary aonex tenant region). Per-tenant
 * overrides happen via the channel row that bootstrap creates.
 *
 * Region is treated as case-INSENSITIVE for channel lookup (see
 * `resolveShopifyChannel`); the canonical written form is uppercase ("AU"),
 * matching bootstrap-channels. Lowercase rows from older seeds still resolve.
 */
export const SHOPIFY_DEFAULT_REGION = "AU";

/** Runtime guard for the unverified `ShopifyProduct` payload coming off the wire. */
function isShopifyProduct(x: unknown): x is ShopifyProduct {
  return typeof x === "object" && x !== null && "id" in x;
}

/**
 * Look up the channel row for a tenant + shop_domain. Mirrors the unique key
 * established by `scripts/bootstrap-channels.ts`:
 *   `(tenantId, channelKind='shopify', region, accountRef=shopDomain)`.
 *
 * Returns null when no matching row exists — caller strips pricing +
 * inventory before invoking the adapter so the catalog_products row still
 * lands (mirrors the Task 4.2 strip-and-warn pattern).
 */
export async function resolveShopifyChannel(
  db: DrizzleClient,
  tenantId: TenantId,
  shopDomain: string,
  region: string
): Promise<{
  channelId: ChannelId;
  defaultCurrency: string | null;
  defaultLocale: string | null;
} | null> {
  // Region is matched case-insensitively: bootstrap-channels writes uppercase
  // ("AU") but older seeds / hand-rolled rows may be lowercase. Normalizing
  // both sides keeps the lookup robust regardless of which side drifted.
  const row = await db.query.channels.findFirst({
    where: (c, { and, eq }) =>
      and(
        eq(c.tenantId, tenantId),
        eq(c.channelKind, "shopify"),
        sql`lower(${c.region}) = lower(${region})`,
        eq(c.accountRef, shopDomain)
      ),
  });
  if (!row) return null;
  return {
    channelId: row.channelId as ChannelId,
    defaultCurrency: row.defaultCurrency ?? null,
    defaultLocale: row.defaultLocale ?? null,
  };
}

export interface RunNewShopifyCatalogPathInput {
  db: DrizzleClient;
  tenantId: TenantId;
  merchantId: MerchantId;
  artifactId: ArtifactId;
  /** e.g. "demo-store.myshopify.com" — used as channel `accountRef`. */
  shopDomain: string;
  /**
   * Tenant region for this Shopify connection. Defaults to
   * `SHOPIFY_DEFAULT_REGION` ('AU') when null, matching bootstrap-channels.
   */
  region: string | null;
  /** Raw Shopify product JSON as drained from Nango. */
  shopifyProduct: ShopifyProduct;
  /** Wall-clock independent — passed in for test determinism. */
  observedAt: Date;
  /**
   * Optional structured logger for the unresolved-channel warning. When
   * omitted, falls back to `console.warn` so direct callers (and tests) still
   * see the drop. The drain processor plumbs its pino logger through.
   */
  logger?: PathLogger;
}

export interface RunNewShopifyCatalogPathResult {
  outcome: AdmitOrStageResult["outcome"];
  /** Set for "admitted" and "enriched"; null for "staged". */
  productId: string | null;
  /** Set for "staged"; null for "admitted" and "enriched". */
  stagedProductId: string | null;
  /** True when a channel row was found for (tenantId, shopify, region, shopDomain). */
  channelResolved: boolean;
}

export async function runNewShopifyCatalogPath(
  input: RunNewShopifyCatalogPathInput
): Promise<RunNewShopifyCatalogPathResult> {
  // Defensive guard at the helper boundary. The drain casts `artifact.raw`
  // (typed as `unknown`) to `ShopifyProduct` before calling us; a malformed
  // payload from upstream produces a meaningful error here instead of a
  // cryptic adapter exception buried in shopify-connector internals. The
  // drain's swallow-and-warn still catches it — but at least the warn log
  // names the actual cause.
  if (!isShopifyProduct(input.shopifyProduct)) {
    throw new Error(
      "runNewShopifyCatalogPath: invalid ShopifyProduct payload — expected an object with 'id' field"
    );
  }

  const {
    db,
    tenantId,
    merchantId,
    artifactId,
    shopDomain,
    region,
    shopifyProduct,
    observedAt,
    logger,
  } = input;

  const effectiveRegion = region ?? SHOPIFY_DEFAULT_REGION;
  const resolved = await resolveShopifyChannel(
    db,
    tenantId,
    shopDomain,
    effectiveRegion
  );
  const channelResolved = resolved !== null;

  // Adapter `ctx.channelDefaultCurrency` is REQUIRED for Shopify (variants
  // don't carry currency on the wire — see shopify-connector index.ts L313).
  // When the channel is unresolved we don't know the currency, so we fall
  // back to a sentinel pass + post-strip below to avoid the adapter throwing.
  const adapter = getAdapter("shopify-connector");
  const channelCode = channelCodeFromShopDomain(shopDomain);

  const adapterInput: ShopifyAdapterInput = {
    product: shopifyProduct,
    shopDomain,
    observedAt,
    artifactId,
  };

  const adapterOutput = adapter.adapt(adapterInput, {
    tenantId,
    // Channel id is opaque to the adapter (it never persists it — the
    // catalog-write layer maps channelCode→channelId at side-table insert
    // time). When unresolved we still need a placeholder so the
    // AdaptContext is well-typed.
    channelId: resolved?.channelId ?? PLACEHOLDER_CHANNEL_ID,
    // For unresolved channels we hand the adapter "AUD" so it doesn't throw
    // on the variant-currency check; we then strip every pricing/inventory
    // observation out below BEFORE calling `writeAdapterOutput`. This keeps
    // the throw site unreachable without lying about the channel in storage.
    channelDefaultCurrency: resolved?.defaultCurrency ?? "AUD",
    channelDefaultLocale: resolved?.defaultLocale ?? null,
    // Phase 4 v1: empty arrays — adapters fall back to default rules.
    attributeDefinitions: [],
    attributeSynonyms: [],
  });

  // Unknown-channel safety net: strip side-table observations so
  // `writeAdapterOutput` doesn't demand a channelCodeToId map. The
  // catalog_products row, revision, and outbox event still land. Log a
  // warning if we dropped observations so the drop is observable.
  let writeOutput = adapterOutput;
  if (!channelResolved) {
    const droppedPricing = adapterOutput.pricingObservations.length;
    const droppedInventory = adapterOutput.inventoryObservations.length;
    if (droppedPricing + droppedInventory > 0) {
      if (logger) {
        logger.warn(
          {
            tenantId,
            accountRef: shopDomain,
            region: effectiveRegion,
            channelKind: "shopify",
            droppedPricing,
            droppedInventory,
          },
          "Shopify channel unresolved; skipping side-table writes"
        );
      } else {
        // eslint-disable-next-line no-console -- fallback for direct callers without a structured logger
        console.warn(
          `[new-catalog-shopify-path] channel unresolved for shopDomain=${shopDomain} region=${effectiveRegion}; dropping ${droppedPricing} pricing + ${droppedInventory} inventory observations`
        );
      }
    }
    writeOutput = {
      ...adapterOutput,
      pricingObservations: [],
      inventoryObservations: [],
    };
  }

  const result = await admitOrStage({
    db,
    tenantId,
    merchantId,
    adapterOutput: writeOutput,
    actor: "shopify:connector",
    sourceKind: "connector:shopify",
    channelCode: channelResolved ? channelCode : null,
    ...(channelResolved && resolved !== null
      ? { channelCodeToId: { [channelCode]: resolved.channelId } }
      : {}),
    sourceArtifactId: artifactId as string,
  });

  return {
    outcome: result.outcome,
    productId: result.productId,
    stagedProductId: result.stagedProductId,
    channelResolved,
  };
}
