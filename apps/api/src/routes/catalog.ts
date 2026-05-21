import { Hono } from "hono";
import type { DrizzleClient } from "@aonex/db";
import {
  listProducts,
  deleteProduct,
  getProductById,
  getProductProvenance,
  getProductSku,
} from "../handlers/catalog.js";
import {
  getProductProvenanceTrace,
  getProductTrace,
} from "../handlers/admin-trace.js";

export interface CatalogRouteDeps {
  db: DrizzleClient;
  /**
   * Phase 4 catalog redesign feature flag, hand-wired from the composition
   * root. When ON, single-product reads serve the new catalog_products
   * shape (winning_values JSONB) instead of the legacy
   * schema.products + product_versions join. See `getProductById`.
   *
   * Also gates the new admin-trace endpoint
   * (`/products/:product_id/provenance/:attribute_code`) — that surface
   * only makes sense against the new-schema rule-driven projection, so
   * it's a 404 (route not found) under the legacy flag-OFF path.
   */
  useNewCatalogSchema: boolean;
}

export function catalogRoutes(deps: CatalogRouteDeps): Hono {
  const app = new Hono();
  app.get("/products", (c) => listProducts(c, deps));
  app.delete("/products/:id", (c) => deleteProduct(c, deps));
  // ORDER MATTERS: hono matches in declaration order. The `/products/:id`
  // route MUST come BEFORE the `/products/:id/provenance` and
  // `/products/:id/sku` routes so `:id` only captures the bare id.
  // (Hono's trie does handle this correctly via longest-match, but keeping
  // them in this order keeps the file legible.)
  app.get("/products/:id", (c) => getProductById(c, deps));
  app.get("/products/:id/provenance", (c) => getProductProvenance(c, deps));
  app.get("/products/:id/sku", (c) => getProductSku(c, deps));

  // New-schema admin trace (Task 4.5, spec §20). 3-segment URL
  // `/products/:product_id/provenance/:attribute_code` — distinct from
  // the legacy 2-segment `/products/:id/provenance` above. Hono matches
  // them independently on segment count.
  //
  // Only mounted under the new-schema flag — the legacy projection has
  // no winning_values / rule-driven trace to surface, so we leave the
  // 3-segment path unhandled (default 404) to keep the API surface
  // honest about which mode is on.
  if (deps.useNewCatalogSchema) {
    app.get("/products/:product_id/provenance/:attribute_code", (c) =>
      getProductProvenanceTrace(c, deps)
    );

    // New-schema product trace (Task 6.1, spec §20). 3-segment URL
    // `/products/:product_id/trace` — distinct from the 4-segment
    // `/products/:product_id/provenance/:attribute_code` declared just
    // above and from the legacy 3-segment `/products/:id/provenance`
    // earlier in this file (Hono matches on the static `/trace` /
    // `/provenance` segment, so the trie disambiguates cleanly).
    //
    // Like the per-attribute provenance trace, this only mounts under
    // the new-schema flag — the legacy projection has no `winning_values`
    // / event outbox / revision log to surface, so the path is 404 (no
    // route) under the legacy flag-OFF surface.
    app.get("/products/:product_id/trace", (c) => getProductTrace(c, deps));
  }

  return app;
}
