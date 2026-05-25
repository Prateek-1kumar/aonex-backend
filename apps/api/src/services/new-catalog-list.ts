// New-schema catalog list reader (Phase 8, Task 8.1 prereq A).
//
// Reads from `catalog_products` and projects rows into the legacy-compatible
// list response shape so frontend consumers see the same envelope without
// a breaking contract change. Phase 9.3: this is now the ONLY list path.
//
// Legacy-compatible shape per row:
//   { id, tenantId, merchantId, status, updatedAt,
//     current_version: null,   // no legacy version concept
//     variants: [],            // deferred per Phase 7
//     pricing: { currency, amount } | null,  // from catalog_pricing_current
//     _meta: { schema: "new" } // migration signal for gradual frontend transition
//   }
//
// Scalar projections from winning_values:
//   title → winning_values.title._unscoped._unscoped.value (or first available)
//   brand → same path for brand
//   gtin  → same path for gtin
//
// Pricing projection from catalog_pricing_current:
//   Prefer the row with channelId matching the sentinel "_unscoped" channel.
//   Because catalog_pricing_current is keyed by (productId, channelId, locale)
//   and "channel" is a UUID FK — there is no literal "_unscoped" channelId UUID —
//   the preference chain for the list view is:
//     1. Row whose locale = "_unscoped" within the first channelId found
//        (the list view is not channel-scoped; we pick ANY channel's unscoped locale
//        to surface a representative price).
//     2. First row ordered by observedAt DESC if no locale="_unscoped" row exists.
//   This mirrors how the legacy `current_price` scalar was populated: one number
//   per product for display in the grid. Strong per-channel pricing lives on
//   the product detail page via `?consistency=strong`.
//
// NOTE: `current_version` is deliberately null for new-schema rows.
// Frontends that deep-access current_version fields (e.g. images, proposed_diff_id)
// need a Phase 9 migration to consume the new winning_values shape directly.
// Until then, the null sentinel is the contract: a product that has
// current_version=null in the list response was migrated to the new schema.

import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import type { TenantId, MerchantId } from "@aonex/types";

// ---- Types -----------------------------------------------------------------

export interface ListCatalogProductRow {
  /** Maps to catalog_products.product_id — same field as legacy `products.id`. */
  id: string;
  tenantId: string;
  merchantId: string;
  status: string;
  updatedAt: Date;
  /** Projected from winning_values.title._unscoped._unscoped.value. */
  title: string | null;
  /** Projected from winning_values.brand._unscoped._unscoped.value. */
  brand: string | null;
  /** Projected from winning_values.gtin._unscoped._unscoped.value. */
  gtin: string | null;
  /**
   * Always null for new-schema rows. Legacy concept: typed product versions
   * don't exist in the new catalog. Frontend code that depends on this field
   * must be migrated in Phase 9 to read from winning_values directly.
   */
  current_version: null;
  /**
   * Always empty for new-schema rows. Variants are deferred per Phase 7.
   * This mirrors the legacy field name so the response envelope is unchanged.
   */
  variants: [];
  /**
   * Representative pricing for the product, sourced from catalog_pricing_current.
   * Preference chain: locale="_unscoped" row (first channel) → first row by observedAt DESC.
   * Null if the product has no pricing row in catalog_pricing_current.
   *
   * NOTE: This is a single representative price for list-view display only.
   * Per-channel pricing lives on the product detail page via `?consistency=strong`.
   */
  pricing: { currency: string; amount: string | null } | null;
  /**
   * Representative thumbnail URL projected from winning_values.images.
   * The link adapter emits `images` as one observation whose value is a
   * SkuImage[] array; we surface the "hero" image (or the first available)
   * so the catalog grid can render a thumbnail instead of a placeholder.
   * Null when the product has no images attribute.
   */
  imageUrl: string | null;
  /**
   * Small migration signal so frontend can transition gradually.
   * Clients SHOULD check `_meta.schema` before accessing `current_version`
   * or `variants` to avoid null-pointer errors.
   */
  _meta: { schema: "new" };
}

export interface ListCatalogProductsOptions {
  tenantId: TenantId;
  merchantId: MerchantId;
  /** Optional status filter. Default: exclude "merged_into". */
  status?: string;
}

// ---- winning_values projection helper --------------------------------------

/**
 * Extract a scalar string from the winning_values JSONB for a given attribute.
 *
 * Preference chain (mirrors validate-backfill.ts `extractWinningValue`):
 *   1. attr._unscoped._unscoped.value
 *   2. First available channel → first available locale → .value
 *
 * Returns null if the attribute is absent or no string leaf is found.
 */
function extractWinningString(
  winningValues: Record<string, unknown> | null | undefined,
  attr: string
): string | null {
  if (!winningValues) return null;

  const attrBlock = winningValues[attr];
  if (!attrBlock || typeof attrBlock !== "object" || Array.isArray(attrBlock)) {
    return null;
  }

  const byChannel = attrBlock as Record<string, unknown>;

  // Prefer _unscoped channel first
  const channels = Object.keys(byChannel).includes("_unscoped")
    ? ["_unscoped", ...Object.keys(byChannel).filter((c) => c !== "_unscoped")]
    : Object.keys(byChannel);

  for (const channel of channels) {
    const byLocale = byChannel[channel];
    if (!byLocale || typeof byLocale !== "object" || Array.isArray(byLocale)) {
      continue;
    }

    const localeMap = byLocale as Record<string, unknown>;

    // Prefer _unscoped locale first
    const locales = Object.keys(localeMap).includes("_unscoped")
      ? ["_unscoped", ...Object.keys(localeMap).filter((l) => l !== "_unscoped")]
      : Object.keys(localeMap);

    for (const locale of locales) {
      const leaf = localeMap[locale];
      if (!leaf || typeof leaf !== "object" || Array.isArray(leaf)) {
        // Leaf might be a scalar (old shape) or an object with .value
        if (typeof leaf === "string" && leaf.length > 0) return leaf;
        continue;
      }
      const leafObj = leaf as Record<string, unknown>;
      if (typeof leafObj.value === "string" && leafObj.value.length > 0) {
        return leafObj.value;
      }
    }
  }

  return null;
}

/**
 * Extract a representative image URL from the winning_values.images attribute.
 *
 * The `images` winner is a SkuImage[] array (the link adapter emits the whole
 * array as one observation value). Unlike title/brand, images are scoped to a
 * real (channelCode, locale) leaf — not `_unscoped` — so we walk all
 * channels/locales (preferring `_unscoped` when present) to find the first
 * non-empty array, then pick the "hero" image (else the lowest-position, else
 * the first entry).
 *
 * Defensive against malformed shapes: tolerates an array of plain URL strings
 * and returns null rather than throwing on anything unexpected.
 */
function extractWinningImageUrl(
  winningValues: Record<string, unknown> | null | undefined
): string | null {
  if (!winningValues) return null;
  const attrBlock = winningValues["images"];
  if (!attrBlock || typeof attrBlock !== "object" || Array.isArray(attrBlock)) {
    return null;
  }
  const byChannel = attrBlock as Record<string, unknown>;
  const channels = Object.keys(byChannel).includes("_unscoped")
    ? ["_unscoped", ...Object.keys(byChannel).filter((c) => c !== "_unscoped")]
    : Object.keys(byChannel);

  for (const channel of channels) {
    const byLocale = byChannel[channel];
    if (!byLocale || typeof byLocale !== "object" || Array.isArray(byLocale)) continue;
    const localeMap = byLocale as Record<string, unknown>;
    const locales = Object.keys(localeMap).includes("_unscoped")
      ? ["_unscoped", ...Object.keys(localeMap).filter((l) => l !== "_unscoped")]
      : Object.keys(localeMap);

    for (const locale of locales) {
      const leaf = localeMap[locale];
      // Winner leaf is { value: SkuImage[] }; tolerate a bare array too.
      const arr = Array.isArray(leaf)
        ? leaf
        : leaf && typeof leaf === "object" && Array.isArray((leaf as { value?: unknown }).value)
          ? ((leaf as { value: unknown[] }).value)
          : null;
      if (!arr || arr.length === 0) continue;

      const url = pickImageUrl(arr);
      if (url) return url;
    }
  }
  return null;
}

/** Pick the best display URL from a SkuImage[]-ish array: hero → lowest position → first. */
function pickImageUrl(images: unknown[]): string | null {
  const objs = images.filter(
    (i): i is Record<string, unknown> => !!i && typeof i === "object"
  );
  if (objs.length > 0) {
    const hero = objs.find((i) => i["role"] === "hero" && typeof i["url"] === "string");
    if (hero) return hero["url"] as string;
    const withPos = objs
      .filter((i) => typeof i["url"] === "string")
      .sort((a, b) => Number(a["position"] ?? 0) - Number(b["position"] ?? 0));
    if (withPos[0]) return withPos[0]["url"] as string;
  }
  // Fallback: array of bare URL strings.
  const firstString = images.find((i) => typeof i === "string" && i.length > 0);
  return typeof firstString === "string" ? firstString : null;
}

// ---- Main export -----------------------------------------------------------

/**
 * List catalog products from the new schema for a given tenant + merchant.
 *
 * Returns rows projected into the legacy-compatible list response shape.
 * `current_version` is always null; `variants` is always [].
 * `pricing` is populated from catalog_pricing_current (batched query, then
 * merged in JS — same pattern as the legacy `listProducts` path which hydrates
 * current_version per-row after the main products query).
 *
 * Pricing selection per product:
 *   1. Row with locale="_unscoped" (any channel, first by channel UUID order).
 *   2. Fallback: first row ordered by observedAt DESC.
 * This surfaces a single representative price for list-view display. Per-channel
 * pricing lives on the detail endpoint via `?consistency=strong`.
 *
 * Frontend consumers that depend on current_version / variants need a Phase 9
 * migration.
 */
export async function listCatalogProducts(
  db: DrizzleClient,
  options: ListCatalogProductsOptions
): Promise<ListCatalogProductRow[]> {
  const { tenantId, merchantId } = options;

  const rows = await db
    .select()
    .from(schema.catalogProducts)
    .where(
      and(
        eq(schema.catalogProducts.tenantId, tenantId),
        eq(schema.catalogProducts.merchantId, merchantId),
        ne(schema.catalogProducts.status, "merged_into")
      )
    )
    .orderBy(desc(schema.catalogProducts.updatedAt));

  if (rows.length === 0) {
    return [];
  }

  // ── Batch-fetch pricing for all returned products ─────────────────────────
  //
  // We fetch ALL catalog_pricing_current rows for the returned product IDs in
  // one query, then group and pick the representative row in JS. This avoids
  // N+1 queries and is consistent with how the legacy listProducts path hydrates
  // current_version (one batch query keyed by id, merged in JS).
  //
  // Picking strategy per product:
  //   1. Prefer locale = "_unscoped" (any channel).
  //   2. Fallback: most-recently-observed row (observedAt DESC).

  const productIds = rows.map((r) => r.productId);

  const pricingRows = await db
    .select({
      productId: schema.catalogPricingCurrent.productId,
      locale: schema.catalogPricingCurrent.locale,
      currency: schema.catalogPricingCurrent.currency,
      primaryAmount: schema.catalogPricingCurrent.primaryAmount,
      observedAt: schema.catalogPricingCurrent.observedAt,
    })
    .from(schema.catalogPricingCurrent)
    .where(inArray(schema.catalogPricingCurrent.productId, productIds))
    .orderBy(desc(schema.catalogPricingCurrent.observedAt));

  // Group pricing rows by productId.
  const pricingByProduct = new Map<
    string,
    { locale: string; currency: string; primaryAmount: string | null; observedAt: Date }[]
  >();
  for (const pr of pricingRows) {
    const list = pricingByProduct.get(pr.productId) ?? [];
    list.push({
      locale: pr.locale,
      currency: pr.currency,
      primaryAmount: pr.primaryAmount ?? null,
      observedAt: pr.observedAt,
    });
    pricingByProduct.set(pr.productId, list);
  }

  /**
   * Pick the representative pricing row for a product.
   * Preference: locale="_unscoped" first, then first by observedAt DESC.
   */
  function pickPricing(
    candidates: { locale: string; currency: string; primaryAmount: string | null }[] | undefined
  ): { currency: string; amount: string | null } | null {
    if (!candidates || candidates.length === 0) return null;
    const unscopedRow = candidates.find((c) => c.locale === "_unscoped");
    const chosen = unscopedRow ?? candidates[0]!;
    return { currency: chosen.currency, amount: chosen.primaryAmount };
  }

  return rows.map((row): ListCatalogProductRow => {
    const wv = (row.winningValues ?? null) as Record<string, unknown> | null;

    return {
      id: row.productId,
      tenantId: row.tenantId,
      merchantId: row.merchantId,
      status: row.status,
      updatedAt: row.updatedAt,
      title: extractWinningString(wv, "title"),
      brand: extractWinningString(wv, "brand"),
      gtin: extractWinningString(wv, "gtin"),
      current_version: null,
      variants: [],
      pricing: pickPricing(pricingByProduct.get(row.productId)),
      imageUrl: extractWinningImageUrl(wv),
      _meta: { schema: "new" },
    };
  });
}
