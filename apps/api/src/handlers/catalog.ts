import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { schema } from "@aonex/db";
import { MerchantId, TenantId } from "@aonex/types";
import type { CatalogRouteDeps } from "../routes/catalog.js";
import {
  readCatalogProductById,
  type Consistency,
} from "../services/new-catalog-read.js";
import { listCatalogProducts } from "../services/new-catalog-list.js";

export async function listProducts(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);

  // Pagination: ?limit (clamped in the service) + opaque ?cursor. A bad/absent
  // limit falls through to the service default rather than erroring.
  const rawLimit = Number(c.req.query("limit"));
  const cursor = c.req.query("cursor");

  const { products, nextCursor, total } = await listCatalogProducts(deps.db, {
    tenantId,
    merchantId,
    ...(Number.isFinite(rawLimit) && rawLimit > 0 ? { limit: rawLimit } : {}),
    ...(cursor ? { cursor } : {}),
  });
  return c.json({ data: { products, nextCursor, total } });
}

export async function deleteProduct(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);
  const id = c.req.param("id") as string;

  const result = await deps.db
    .update(schema.catalogProducts)
    .set({ status: "deleted", updatedAt: new Date() })
    .where(
      and(
        eq(schema.catalogProducts.productId, id),
        eq(schema.catalogProducts.tenantId, tenantId),
        eq(schema.catalogProducts.merchantId, merchantId)
      )
    )
    .returning({ id: schema.catalogProducts.productId });

  if (result.length === 0) {
    return c.json({ error: { code: "NOT_FOUND", message: "Product not found" } }, 404);
  }
  return c.json({ data: { id: result[0]!.id, status: "deleted" } });
}

/**
 * GET /products/:id — fetch a single catalog product by id.
 *
 * Reads `schema.catalogProducts` directly. Returns the `winning_values` JSONB
 * as stored (full `_meta` block + per-attribute leaves). Frontend consumers do
 * their own per-channel/per-locale projection; this endpoint never mutates the
 * shape.
 *
 * Query params:
 *   - `consistency=eventual` (default) — read the cached `winning_values` JSONB.
 *     Cheap (single row), but lags the side tables by up to the debounced
 *     reconciler window (~2s).
 *   - `consistency=strong` — JOIN `catalog_pricing_current` and
 *     `catalog_inventory_current` on `product_id`, replacing the
 *     `winning_values.pricing` and `winning_values.inventory` leaves with the
 *     live side-table rows. Higher latency. Use when the caller cannot tolerate
 *     reconciler lag (e.g. admin "after-edit" re-read flows).
 *
 * Response always includes a `consistency` field stamped with the mode that
 * was honored ("eventual" or "strong"). Any other value for the `?consistency`
 * param (typo, garbage) returns 400 — fail-loud beats silently degrading.
 *
 * Cross-tenant safety: we return 404, never 403 or empty 200, when the row
 * exists but belongs to a different tenant.
 */
export async function getProductById(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const merchantId = MerchantId.unsafeFrom(c.get("merchantId" as never) as string);
  const productId = c.req.param("id") as string;

  // Validate `?consistency` query param: only "strong" or "eventual" (or
  // omitted, which defaults to "eventual") are accepted.
  const rawConsistency = c.req.query("consistency");
  if (
    rawConsistency !== undefined &&
    rawConsistency !== "strong" &&
    rawConsistency !== "eventual"
  ) {
    return c.json(
      {
        error: {
          code: "INVALID_QUERY",
          message:
            "consistency must be one of: 'strong', 'eventual' (or omitted)",
        },
      },
      400
    );
  }
  const consistency: Consistency =
    rawConsistency === "strong" ? "strong" : "eventual";

  const view = await readCatalogProductById(deps.db, tenantId, productId, {
    consistency,
  });
  if (!view) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Product not found" } },
      404
    );
  }
  // Enforce merchant boundary: return 404 (not 403) to avoid leaking existence
  // across merchants.
  if (view.merchant_id !== merchantId) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Product not found" } },
      404
    );
  }
  return c.json({ data: view });
}

/**
 * GET /products/:id/provenance — DEPRECATED (Phase 9.3).
 *
 * This legacy endpoint read from product_versions + proposed_diffs which were
 * renamed to _legacy_* in Phase 8 and dropped in Phase 9.1. Use the new
 * per-attribute trace endpoint instead:
 *   GET /products/:product_id/provenance/:attribute_code
 */
export async function getProductProvenance(c: Context, _deps: CatalogRouteDeps): Promise<Response> {
  return c.json(
    {
      error: {
        code: "GONE",
        message:
          "This endpoint has been removed. Use GET /products/:product_id/provenance/:attribute_code for per-attribute provenance.",
      },
    },
    410
  );
}

/**
 * GET /products/:id/sku — DEPRECATED (Phase 9.3).
 *
 * This legacy endpoint rebuilt SkuJson by walking product_versions →
 * proposed_diffs → link_ingestion_trace_facts. Those tables were renamed to
 * _legacy_* in Phase 8. The sku shape is now available via winning_values on
 * the GET /products/:id response.
 */
export async function getProductSku(c: Context, _deps: CatalogRouteDeps): Promise<Response> {
  return c.json(
    {
      error: {
        code: "GONE",
        message:
          "This endpoint has been removed. SKU data is now available in winning_values via GET /products/:id.",
      },
    },
    410
  );
}
