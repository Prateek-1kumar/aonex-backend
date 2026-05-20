import { Hono } from "hono";
import type { DrizzleClient } from "@aonex/db";
import { listProducts, deleteProduct, getProductProvenance, getProductSku } from "../handlers/catalog.js";

export interface CatalogRouteDeps {
  db: DrizzleClient;
}

export function catalogRoutes(deps: CatalogRouteDeps): Hono {
  const app = new Hono();
  app.get("/products", (c) => listProducts(c, deps));
  app.delete("/products/:id", (c) => deleteProduct(c, deps));
  app.get("/products/:id/provenance", (c) => getProductProvenance(c, deps));
  app.get("/products/:id/sku", (c) => getProductSku(c, deps));
  return app;
}
