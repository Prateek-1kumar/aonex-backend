// Builds the taxonomy-classifier closure the ingestion spine calls at the
// `classify` stage. The spine package stays free of the classifier + the
// DB→index load; the worker owns both here (mirroring the index build in
// jobs/classify-uncategorized.ts) and caches the index with a short TTL so a
// burst of ingests doesn't re-scan the taxonomy per product.

import { schema, type DrizzleClient } from "@aonex/db";
import {
  buildIndex,
  classifyWithFallback,
  type ClassifierIndex,
  type ClassifierResolver,
  type ProductSignals,
} from "@aonex/taxonomy-classifier";
import type { SpineCategoryClassifier } from "@aonex/ingestion-spine";

/**
 * Produce a `SpineCategoryClassifier` over a cached taxonomy index + the given
 * resolver (LLM in prod; deterministic dry-run otherwise). Returns `abstain`
 * when the taxonomy is empty so ingestion still proceeds (category stays
 * unresolved → surfaces in the Review Queue).
 */
export function makeCategoryClassifier(
  db: DrizzleClient,
  resolver: ClassifierResolver,
  ttlMs = 60_000
): SpineCategoryClassifier {
  let cached: { index: ClassifierIndex; at: number } | null = null;

  async function loadIndex(): Promise<ClassifierIndex> {
    if (cached && Date.now() - cached.at < ttlMs) return cached.index;
    const nodes = await db.select().from(schema.taxonomyNodes);
    const aliasMap = new Map(
      (await db.select().from(schema.taxonomyAliases)).map((a) => [a.normalizedLabel, a.nodeId])
    );
    const index = buildIndex(
      nodes.filter((n) => n.isLeaf).map((n) => ({ nodeId: n.nodeId, displayName: n.displayName })),
      aliasMap,
      nodes.filter((n) => n.level === 0).map((n) => ({ id: n.nodeId, name: n.displayName }))
    );
    cached = { index, at: Date.now() };
    return index;
  }

  return async (signals) => {
    const index = await loadIndex();
    if (index.leaves.length === 0) return { nodeId: null, confidence: 0, outcome: "abstain" };
    const productSignals: ProductSignals = {
      ...(signals.title ? { title: signals.title } : {}),
      ...(signals.brand ? { brand: signals.brand } : {}),
      ...(signals.sourceCategory ? { sourceCategory: signals.sourceCategory } : {}),
    };
    const r = await classifyWithFallback(productSignals, index, resolver);
    return { nodeId: r.nodeId, confidence: r.confidence, outcome: r.outcome };
  };
}
