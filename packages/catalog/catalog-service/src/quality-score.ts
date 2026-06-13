// Unified product-quality scoring: completeness (spec coverage vs the product's
// taxonomy leaf schema, archetype-rubric fallback when uncategorized) and content
// quality (universal content rubric), both graded against the schema enrichment
// fills. The leaf-schema index is module-cached (TTL) so bulk reconciles avoid N scans.

import type { DrizzleClient } from "@aonex/db";
import {
  contentQualityOf,
  flattenWinningAttrs,
  leafSchemaFor,
  loadLeafSchemas,
  type LeafSchemaIndex,
} from "@aonex/taxonomy-schema";
import { validateAttributes } from "@aonex/taxonomy-validator";

let cache: { index: LeafSchemaIndex; at: number } | null = null;
const TTL_MS = 60_000;

/** Injectable for tests; defaults to the cached DB load. */
export type LeafIndexLoader = (db: DrizzleClient) => Promise<LeafSchemaIndex>;

async function defaultLoad(db: DrizzleClient): Promise<LeafSchemaIndex> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.index;
  const index = await loadLeafSchemas(db);
  cache = { index, at: Date.now() };
  return index;
}

export interface TaxonomyQuality {
  /** Spec completeness 0..100 vs the taxonomy leaf schema, or null when the
   *  product is uncategorized / the node has no schema (caller falls back). */
  specCompleteness: number | null;
  /** Per-tier coverage of the leaf spec schema (when specCompleteness != null). */
  specBreakdown?: { required: number; recommended: number; optional: number };
  /** Content quality 0..100 (universal content rubric). Always computed. */
  contentQuality: number;
}

/** Score a product's reconciled winning_values against its taxonomy leaf schema
 *  (specs) + the universal content rubric. Never throws — on any load failure it
 *  returns specCompleteness=null so the caller uses the archetype fallback. */
export async function computeTaxonomyQuality(
  db: DrizzleClient,
  args: { categoryNodeId: string | null; winningValues: Record<string, unknown> | null },
  load: LeafIndexLoader = defaultLoad
): Promise<TaxonomyQuality> {
  const flat = flattenWinningAttrs((args.winningValues ?? {}) as Record<string, unknown>);
  const contentQuality = contentQualityOf(flat);

  if (!args.categoryNodeId) return { specCompleteness: null, contentQuality };
  try {
    const index = await load(db);
    const leaf = leafSchemaFor(index, args.categoryNodeId);
    if (!leaf) return { specCompleteness: null, contentQuality };
    const c = validateAttributes(leaf, flat).completeness;
    return {
      specCompleteness: c.score,
      specBreakdown: { required: c.required, recommended: c.recommended, optional: c.optional },
      contentQuality,
    };
  } catch {
    return { specCompleteness: null, contentQuality };
  }
}
