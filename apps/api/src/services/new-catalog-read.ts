// New-schema catalog single-product reader (Task 4.4).
//
// Runs ONLY when `useNewCatalogSchema` is on — the legacy
// `schema.products` reader stays the default path in the handler. This
// helper is intentionally read-only and side-effect-free; it returns a
// plain JSON-able object that the handler relays directly via `c.json`.
//
// Consistency modes:
//
//   "eventual" (default): read catalog_products.winning_values JSONB as
//     stored by the debounced async reconciler. Cheap (single row read),
//     but lags the side tables by up to the reconciler debounce window
//     (currently ~2s for pricing/inventory).
//
//   "strong": read catalog_products + JOIN catalog_pricing_current and
//     catalog_inventory_current on (product_id). Replaces the
//     winning_values.pricing / .inventory leaves with the live side-table
//     rows. Higher latency (extra round trips) but no reconciler lag.
//
// Cross-tenant safety: the SELECT filters by tenantId AND productId.
// A wrong-tenant request returns `null` so the handler can render a
// generic 404 without leaking row existence.

import { eq, and } from "drizzle-orm";
import { schema } from "@aonex/db";
import type { DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";

/** Read consistency level for the new-schema product read. */
export type Consistency = "eventual" | "strong";

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
   * Reconciler-projected winning values JSONB. Under `consistency=strong`,
   * the `pricing` / `inventory` keys are replaced with live side-table rows.
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
    // with the latest current rows. We keep other winning-value attrs
    // untouched (title, brand, etc. don't have a "_current" projection
    // — they're sync-recomputed by projectSync).
    const [pricingRows, inventoryRows] = await Promise.all([
      db
        .select()
        .from(schema.catalogPricingCurrent)
        .where(eq(schema.catalogPricingCurrent.productId, productId)),
      db
        .select()
        .from(schema.catalogInventoryCurrent)
        .where(eq(schema.catalogInventoryCurrent.productId, productId)),
    ]);

    finalWinningValues = {
      ...winningValues,
      pricing: pricingRows,
      inventory: inventoryRows,
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
