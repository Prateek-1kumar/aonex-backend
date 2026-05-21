// Admin trace handler — Task 4.5, spec §20.
//
// Endpoint:
//   GET /products/:product_id/provenance/:attribute_code
//     ?channel=<channelCode>&locale=<locale>
//
// Returns the FULL chain that produced the currently-winning value for
// one (product, attribute, channel, locale) leaf:
//   winner → source_priority rule that picked it → underlying observation
//   → source artifact id → (Phase 5+) raw payload pointer.
//
// Wiring contract: the route is mounted ONLY when
// `useNewCatalogSchema=true` on the catalog routes deps. Under the
// legacy flag-OFF surface there's no `winning_values` or rule-driven
// projection to trace, so the endpoint returns 404 (same as
// "route not found" — Hono falls through to its default 404 handler).
//
// Auth / safety:
//   - tenantId + merchantId come from the JWT-stamped context vars
//     (same convention as `getProductById`).
//   - Cross-tenant 404: row exists but belongs to a different tenant →
//     404, never 403 or empty 200.
//   - Cross-merchant 404: row exists in the same tenant but belongs to
//     a different merchant → 404. Mirrors Task 4.4 (`getProductById`).
//   - Non-UUID `product_id` → 400, not 404, so callers get a clear
//     "bad input" signal vs. "valid id but no such row".

import type { Context } from "hono";
import { MerchantId, TenantId } from "@aonex/types";
import type { CatalogRouteDeps } from "../routes/catalog.js";
import {
  readProvenance,
  PRODUCT_NOT_FOUND,
} from "../services/new-catalog-provenance.js";

/** Tight UUID v1-v5 regex. Permissive enough for any well-formed id. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Lenient UUID detector that also accepts the all-zero / all-`f` test
 * UUIDs used in seeds — those are valid v0/synthetic ids that our test
 * infrastructure relies on. A strict v1-v5 check would reject them.
 */
function looksLikeUuid(s: string): boolean {
  if (UUID_RE.test(s)) return true;
  // 8-4-4-4-12 structure, hex only — permissive fallback for synthetic test UUIDs.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * GET /products/:product_id/provenance/:attribute_code — trace the
 * winning value for one (product, attribute, channel, locale) leaf
 * back to the rule, observation, and source artifact that produced it.
 *
 * Query params:
 *   - `channel` (default `"_unscoped"`): channel CODE
 *     (e.g. `"shopify-au"`). For sync attributes (title, brand, ...)
 *     this is the outer key in `catalog_products.values[attr]`. For
 *     pricing/inventory this is translated to a channel UUID via
 *     `(tenantId, channelKind)` for the side-table query.
 *   - `locale` (default `"_unscoped"`): locale code (e.g. `"en_AU"`).
 *     Pricing uses this on `catalog_pricing_observations.locale`.
 *     Inventory has no locale dimension and ignores this param.
 *
 * Responses:
 *   - 200 with the trace, OR with all-null fields when the product
 *     exists but the leaf has no observations (distinguishes "no data"
 *     from "no product" — frontends can render "no winner" without
 *     coding around a 404).
 *   - 400 when `product_id` isn't a UUID.
 *   - 404 when the product doesn't exist OR belongs to a different
 *     tenant/merchant.
 */
export async function getProductProvenanceTrace(
  c: Context,
  deps: CatalogRouteDeps
): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const merchantId = MerchantId.unsafeFrom(
    c.get("merchantId" as never) as string
  );

  const productId = c.req.param("product_id") as string;
  const attributeCode = c.req.param("attribute_code") as string;

  if (!productId || !looksLikeUuid(productId)) {
    return c.json(
      {
        error: {
          code: "INVALID_PRODUCT_ID",
          message: "product_id must be a UUID",
        },
      },
      400
    );
  }
  if (!attributeCode || attributeCode.length === 0) {
    return c.json(
      {
        error: {
          code: "INVALID_ATTRIBUTE_CODE",
          message: "attribute_code is required",
        },
      },
      400
    );
  }

  // Defaults: `_unscoped` matches the writer convention for
  // channel/locale-agnostic attributes (brand, description, ...).
  const channel = c.req.query("channel") ?? "_unscoped";
  const locale = c.req.query("locale") ?? "_unscoped";

  const result = await readProvenance(deps.db, {
    tenantId,
    merchantId,
    productId,
    attributeCode,
    channel,
    locale,
  });

  if (result === PRODUCT_NOT_FOUND) {
    return c.json(
      { error: { code: "NOT_FOUND", message: "Product not found" } },
      404
    );
  }

  return c.json({ data: result });
}
