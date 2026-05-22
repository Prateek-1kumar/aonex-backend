// New-schema catalog list reader (Phase 8, Task 8.1 prereq A).
//
// Runs ONLY when `useNewCatalogSchema` is on in `listProducts`. This service
// reads from `catalog_products` and projects rows into the legacy-compatible
// list response shape so frontend consumers see the same envelope without
// a breaking contract change.
//
// Legacy-compatible shape per row:
//   { id, tenantId, merchantId, status, updatedAt,
//     current_version: null,   // no legacy version concept
//     variants: [],            // deferred per Phase 7
//     _meta: { schema: "new" } // migration signal for gradual frontend transition
//   }
//
// Scalar projections from winning_values:
//   title → winning_values.title._unscoped._unscoped.value (or first available)
//   brand → same path for brand
//   gtin  → same path for gtin
//
// NOTE: `current_version` is deliberately null for new-schema rows.
// Frontends that deep-access current_version fields (e.g. images, proposed_diff_id)
// need a Phase 9 migration to consume the new winning_values shape directly.
// Until then, the null sentinel is the contract: a product that has
// current_version=null in the list response was migrated to the new schema.

import { and, desc, eq, ne } from "drizzle-orm";
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

// ---- Main export -----------------------------------------------------------

/**
 * List catalog products from the new schema for a given tenant + merchant.
 *
 * Returns rows projected into the legacy-compatible list response shape.
 * `current_version` is always null; `variants` is always [].
 * Frontend consumers that depend on those fields need a Phase 9 migration.
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
      _meta: { schema: "new" },
    };
  });
}
