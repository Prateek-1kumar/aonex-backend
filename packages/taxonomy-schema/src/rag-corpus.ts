// Catalog-RAG corpus: turn catalog_products rows into the CatalogEntry list
// the enrichment retriever ranks over. One implementation for the worker
// enrichment job and the eval harness.

import { schema, type DrizzleClient } from "@aonex/db";
import { departmentOf, type CatalogEntry } from "@aonex/taxonomy-enrichment";
import { asText, firstScoped, flattenWinningAttrs } from "./winning-values.js";

/** The catalog_products columns the corpus build reads. */
export interface CatalogProductLike {
  winningValues?: unknown;
  identity?: unknown;
  categoryNodeId?: string | null;
}

/** A single product row -> retrievable corpus entry; null when the product has
 *  no usable title (nothing to rank on). */
export function toCatalogEntry(p: CatalogProductLike): CatalogEntry | null {
  const wv = (p.winningValues ?? {}) as Record<string, unknown>;
  const identity = (p.identity ?? {}) as Record<string, unknown>;
  const title = asText(firstScoped(wv.title));
  if (!title) return null;
  const departmentId = p.categoryNodeId ? departmentOf(p.categoryNodeId) : undefined;
  return {
    title,
    ...(identity.brand ? { brand: String(identity.brand) } : {}),
    ...(p.categoryNodeId ? { nodeId: p.categoryNodeId } : {}),
    ...(departmentId !== undefined ? { departmentId } : {}),
    attrs: flattenWinningAttrs(wv),
  };
}

export function buildRagCorpus(products: CatalogProductLike[]): CatalogEntry[] {
  return products.map(toCatalogEntry).filter((e): e is CatalogEntry => e !== null);
}

/** Load the corpus from the whole catalog. `excludeProductId` keeps the
 *  product being enriched out of its own few-shot examples. Fine at current
 *  catalog sizes; cap or sample at the call-site if the catalog grows large. */
export async function loadRagCorpus(
  db: DrizzleClient,
  opts: { excludeProductId?: string } = {}
): Promise<CatalogEntry[]> {
  const rows = await db.select().from(schema.catalogProducts);
  return buildRagCorpus(
    opts.excludeProductId ? rows.filter((r) => r.productId !== opts.excludeProductId) : rows
  );
}
