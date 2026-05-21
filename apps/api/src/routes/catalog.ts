import { Hono } from "hono";
import type { DrizzleClient } from "@aonex/db";
import {
  listProducts,
  deleteProduct,
  getProductById,
  getProductProvenance,
  getProductSku,
} from "../handlers/catalog.js";

export interface CatalogRouteDeps {
  db: DrizzleClient;
  /**
   * Phase 4 catalog redesign feature flag, hand-wired from the composition
   * root. When ON, single-product reads serve the new catalog_products
   * shape (winning_values JSONB) instead of the legacy
   * schema.products + product_versions join. See `getProductById`.
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
  return app;
}
