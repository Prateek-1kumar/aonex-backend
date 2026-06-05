// HTTP routes for the catalog read/admin surface.
//
// Mounts product list/detail/delete plus provenance & trace endpoints onto a
// Hono router. Route order is load-bearing (see inline note). Spec §20.

import { Hono } from "hono";
import type { Queue } from "bullmq";
import type { DrizzleClient } from "@aonex/db";
import { type QUEUE } from "@aonex/types";
import {
  listProducts,
  deleteProduct,
  getProductById,
  getProductProvenance,
  getProductSku,
} from "../handlers/catalog.js";
import {
  startEnrichment,
  getEnrichmentProposal,
  applyEnrichment,
  rejectEnrichment,
} from "../handlers/enrichment.js";
import {
  getProductProvenanceTrace,
  getProductTrace,
} from "../handlers/admin-trace.js";

export interface CatalogRouteDeps {
  db: DrizzleClient;
  /** Optional so read-only handler tests can construct deps as `{ db }`;
   *  the composition root always provides it for the enrichment endpoints. */
  queues?: { [QUEUE.PRODUCT_ENRICH]: Queue };
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

  // Catalog enrichment ("Push to Enrich") — async start + poll + review-then-apply.
  app.post("/products/:id/enrich", (c) => startEnrichment(c, deps));
  app.get("/products/:id/enrich/:proposalId", (c) => getEnrichmentProposal(c, deps));
  app.post("/products/:id/enrich/:proposalId/apply", (c) => applyEnrichment(c, deps));
  app.post("/products/:id/enrich/:proposalId/reject", (c) => rejectEnrichment(c, deps));

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
