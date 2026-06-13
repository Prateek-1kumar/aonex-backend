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

/** A corpus entry paired with its product id, so callers that cache the
 *  corpus across jobs can exclude the product being enriched per job. */
export interface CorpusEntryWithId {
  productId: string;
  entry: CatalogEntry;
}

/** Load the corpus from the whole catalog, fetching only the three columns the
 *  corpus build reads (the products table's `values` observation log is by far
 *  its heaviest column — never pull it here). Fine at current catalog sizes;
 *  cap or sample at the call-site if the catalog grows large. */
export async function loadRagCorpusEntries(db: DrizzleClient): Promise<CorpusEntryWithId[]> {
  const rows = await db
    .select({
      productId: schema.catalogProducts.productId,
      winningValues: schema.catalogProducts.winningValues,
      identity: schema.catalogProducts.identity,
      categoryNodeId: schema.catalogProducts.categoryNodeId,
    })
    .from(schema.catalogProducts);
  const out: CorpusEntryWithId[] = [];
  for (const row of rows) {
    const entry = toCatalogEntry(row);
    if (entry) out.push({ productId: row.productId, entry });
  }
  return out;
}

/** Convenience wrapper: the plain CatalogEntry list, optionally excluding the
 *  product being enriched (so it can't be its own few-shot example). */
export async function loadRagCorpus(
  db: DrizzleClient,
  opts: { excludeProductId?: string } = {}
): Promise<CatalogEntry[]> {
  const entries = await loadRagCorpusEntries(db);
  return entries
    .filter((e) => e.productId !== opts.excludeProductId)
    .map((e) => e.entry);
}
