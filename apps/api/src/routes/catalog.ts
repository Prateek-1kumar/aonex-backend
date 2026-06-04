// HTTP routes for the catalog read/admin surface.
//
// Mounts product list/detail/delete plus provenance & trace endpoints onto a
// Hono router. Route order is load-bearing (see inline note). Spec §20.

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

  // Admin trace endpoints — new-schema only (catalog_products + winning_values).
  // These are the canonical paths; the legacy provenance endpoint above is
  // kept for backward compatibility but reads from the legacy proposed_diffs chain.
  app.get("/products/:product_id/provenance/:attribute_code", (c) =>
    getProductProvenanceTrace(c, deps)
  );

  // Product trace — full debug payload (Task 6.1, spec §20).
  app.get("/products/:product_id/trace", (c) => getProductTrace(c, deps));

  return app;
}
