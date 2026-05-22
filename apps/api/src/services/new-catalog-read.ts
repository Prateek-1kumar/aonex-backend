// New-schema catalog single-product reader (Task 4.4).
//
// Reads from `catalog_products`. Phase 9.3: this is now the ONLY read path
// (legacy flag removed). Intentionally read-only and side-effect-free;
// returns a plain JSON-able object that the handler relays directly via `c.json`.
//
// Consistency modes:
//
//   "eventual" (default): read catalog_products.winning_values JSONB as
//     stored by the debounced async reconciler. Cheap (single row read),
//     but lags the side tables by up to the reconciler debounce window
//     (currently ~2s for pricing/inventory).
//
//   "strong": read catalog_products + side-table SELECTs on
//     catalog_pricing_current and catalog_inventory_current. Project
//     those live rows into the SAME nested object shape the reconciler
//     writes (channelId UUID → locale/locKey → leaf), then overlay them
//     on top of the cached `winning_values.pricing` / `.inventory`. Higher
//     latency (extra round trips) but no reconciler lag.
//
//     IMPORTANT (shape contract): the output of `winning_values.pricing`
//     and `winning_values.inventory` is IDENTICAL between modes — only
//     the data freshness differs. Both modes key by `channelId` (UUID)
//     in the outer dimension and `locale` (pricing) or `locationKey`
//     (inventory, with the sentinel UUID for NULL location) in the inner
//     dimension. Frontend consumers never need to special-case strong vs
//     eventual on shape — only on staleness tolerance.
//
// Cross-tenant safety: the SELECT filters by tenantId AND productId.
// A wrong-tenant request returns `null` so the handler can render a
// generic 404 without leaking row existence.

import { eq, and, asc } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";

/** Read consistency level for the new-schema product read. */
export type Consistency = "eventual" | "strong";

/**
 * Sentinel UUID used by the reconciler as the inventory locationKey when
 * `location_id` is NULL — JSON object keys can't be `null`, so the
 * reconciler (and this strong-mode projection) coalesce NULL to this
 * value. Mirrors `NULL_LOCATION_SENTINEL` in
 * `packages/catalog/catalog-service/src/reconciler/async-debounced.ts`
 * and the STORED generated column `location_id_coalesced` in
 * migrations/0012. We keep a local copy here rather than importing from
 * catalog-service because this read path must not depend on the worker
 * package (cycle avoidance + smaller blast radius at boot).
 */
const NULL_LOCATION_SENTINEL = "00000000-0000-0000-0000-000000000000";

/**
 * Pricing leaf shape — matches `PricingWinnerValue` produced by the
 * reconciler's `reconcilePricing`. In strong mode we additionally
 * surface `primaryAmount` (numeric) because the side table stores it
 * and consumers benefit from a denormalized single-number price field.
 */
interface StrongPricingLeaf {
  source: string;
  currency: string;
  primaryAmount: string | null;
  tiers: unknown;
  pricePerUnit: unknown;
  observedAt: string;
}

/**
 * Inventory leaf shape — matches `InventoryWinnerValue` produced by the
 * reconciler's `reconcileInventory`. The side table `catalog_inventory_current`
 * intentionally only stores hot-path columns (qty + source + observed_at)
 * per spec §9.1, so the strong-mode leaf here is a subset of what the
 * eventual-mode (reconciler-cached) leaf carries — the extras
 * (clickCollectEligible, purchaseLimit, backorderAllowed) live only in
 * the cached `winning_values.inventory` block and stay there unchanged
 * across the overlay (we merge per-(channel,loc), not replace wholesale).
 */
interface StrongInventoryLeaf {
  source: string;
  qty: number;
  observedAt: string;
}

/** Shape returned by `readCatalogProductById`. Mirrors what the handler ships. */
export interface NewCatalogProductView {
  product_id: string;
  tenant_id: string;
  merchant_id: string;
  primary_identifier: string;
  identity: unknown;
  status: string;
  family: string | null;
  values: unknown;
  /**
   * Reconciler-projected winning values JSONB.
   *
   * Shape contract — IDENTICAL across consistency modes:
   *   - `winning_values.pricing[channelId][locale] = PricingWinnerValue`
   *   - `winning_values.inventory[channelId][locKey] = InventoryWinnerValue`
   *     (where `locKey` is the `location_id` UUID or the sentinel UUID
   *     `00000000-0000-0000-0000-000000000000` for NULL location).
   *
   * Under `consistency=strong`, the `pricing` / `inventory` sub-objects
   * are recomputed from `catalog_pricing_current` / `catalog_inventory_current`
   * (live side-table reads) and overlaid on top of the cached values
   * keyed by (channelId, locale/locKey). The OUTER shape — channelId-UUID
   * keyed nested objects — is preserved so a client written against the
   * eventual shape doesn't need to re-implement parsing under strong.
   */
  winning_values: Record<string, unknown>;
  schema_version: string;
  current_revision_id: number | null;
  parent_product_id: string | null;
  merged_into_product_id: string | null;
  created_at: Date;
  updated_at: Date;
  /** Consistency level honored by this response. */
  consistency: Consistency;
}

/**
 * Two-level merge: for each outer key present in EITHER side, merge the
 * inner objects (overlay = wins on inner-key collision). Used to overlay
 * fresh side-table projections on top of cached `winning_values.pricing`
 * / `.inventory` without losing cached-only attributes on inner keys
 * that didn't change between the two reads.
 *
 * Not a deep merge — we stop at the leaf object (which is the
 * `PricingWinnerValue` / `InventoryWinnerValue` shape). The overlay leaf
 * fully replaces the cached leaf on key collision, so a stale cached
 * `qty` doesn't bleed into the live response on the same (channel, loc).
 */
function mergeNested<T>(
  base: Record<string, Record<string, unknown>>,
  overlay: Record<string, Record<string, T>>
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  const allChannels = new Set([
    ...Object.keys(base),
    ...Object.keys(overlay),
  ]);
  for (const ch of allChannels) {
    const baseInner = base[ch] ?? {};
    const overlayInner = overlay[ch] ?? {};
    out[ch] = { ...baseInner, ...overlayInner };
  }
  return out;
}

/**
 * Fetch a single catalog product by id, scoped to the requester's tenant.
 *
 * Returns `null` when:
 *   - the product doesn't exist, OR
 *   - the product belongs to a different tenant (cross-tenant 404 policy).
 *
 * The caller maps `null` to a 404 response. Never throws on "not found".
 */
export async function readCatalogProductById(
  db: DrizzleClient,
  tenantId: TenantId,
  productId: string,
  opts: { consistency: Consistency }
): Promise<NewCatalogProductView | null> {
  const rows = await db
    .select()
    .from(schema.catalogProducts)
    .where(
      and(
        eq(schema.catalogProducts.productId, productId),
        eq(schema.catalogProducts.tenantId, tenantId)
      )
    )
    .limit(1);

  const product = rows[0];
  if (!product) return null;

  const winningValues = (product.winningValues ?? {}) as Record<string, unknown>;

  let finalWinningValues: Record<string, unknown> = winningValues;

  if (opts.consistency === "strong") {
    // Side-table live read. Replace the cached pricing/inventory leaves
    // with the latest current rows — projected into the SAME
    // channelId-UUID-keyed nested shape the reconciler writes, so the
    // wire shape is identical between modes. We keep other winning-value
    // attrs untouched (title, brand, etc. don't have a "_current"
    // projection — they're sync-recomputed by projectSync).
    //
    // Determinism: the `.orderBy` clauses below aren't strictly required
    // because the output is keyed by stable UUIDs (so the JSON object
    // ordering is determined by insertion order into the bucket), but
    // sorted SELECTs give debug logs and the natural-order grouping a
    // predictable shape. Cost is negligible — both tables have suitable
    // composite indexes (PK covers (product_id, channel_id, locale/loc)).
    const [pricingRows, inventoryRows] = await Promise.all([
      db
        .select()
        .from(schema.catalogPricingCurrent)
        .where(eq(schema.catalogPricingCurrent.productId, productId))
        .orderBy(
          asc(schema.catalogPricingCurrent.channelId),
          asc(schema.catalogPricingCurrent.locale)
        ),
      db
        .select()
        .from(schema.catalogInventoryCurrent)
        .where(eq(schema.catalogInventoryCurrent.productId, productId))
        .orderBy(
          asc(schema.catalogInventoryCurrent.channelId),
          asc(schema.catalogInventoryCurrent.locationId)
        ),
    ]);

    // Project pricing rows: { [channelId]: { [locale]: StrongPricingLeaf } }
    const pricing: Record<string, Record<string, StrongPricingLeaf>> = {};
    for (const row of pricingRows) {
      const byChannel = pricing[row.channelId] ?? {};
      byChannel[row.locale] = {
        source: row.source,
        currency: row.currency,
        // numeric → string via pg driver. Preserve fidelity (no parseFloat).
        primaryAmount: row.primaryAmount ?? null,
        tiers: row.tiers,
        pricePerUnit: row.pricePerUnit,
        observedAt: row.observedAt.toISOString(),
      };
      pricing[row.channelId] = byChannel;
    }

    // Project inventory rows: { [channelId]: { [locKey]: StrongInventoryLeaf } }
    // NULL locationId → sentinel UUID, matching the reconciler's
    // winning_values key choice (JSON has no null keys).
    const inventory: Record<string, Record<string, StrongInventoryLeaf>> = {};
    for (const row of inventoryRows) {
      const locKey = row.locationId ?? NULL_LOCATION_SENTINEL;
      const byChannel = inventory[row.channelId] ?? {};
      byChannel[locKey] = {
        source: row.source,
        qty: row.qty,
        observedAt: row.observedAt.toISOString(),
      };
      inventory[row.channelId] = byChannel;
    }

    // Overlay (NOT wholesale replace) so the cached-only extras on
    // inventory leaves (clickCollectEligible, purchaseLimit,
    // backorderAllowed) survive into the strong-mode response on
    // channel/loc pairs that the side table also has. For pricing, the
    // side table is a strict superset of what the reconciler stores —
    // a full overlay-by-leaf is also correct.
    finalWinningValues = {
      ...winningValues,
      pricing: mergeNested(
        (winningValues.pricing as Record<string, Record<string, unknown>> | undefined) ?? {},
        pricing
      ),
      inventory: mergeNested(
        (winningValues.inventory as Record<string, Record<string, unknown>> | undefined) ?? {},
        inventory
      ),
    };
  }

  return {
    product_id: product.productId,
    tenant_id: product.tenantId,
    merchant_id: product.merchantId,
    primary_identifier: product.primaryIdentifier,
    identity: product.identity,
    status: product.status,
    family: product.family,
    values: product.values,
    winning_values: finalWinningValues,
    schema_version: product.schemaVersion,
    current_revision_id: product.currentRevisionId,
    parent_product_id: product.parentProductId,
    merged_into_product_id: product.mergedIntoProductId,
    created_at: product.createdAt,
    updated_at: product.updatedAt,
    consistency: opts.consistency,
  };
}
