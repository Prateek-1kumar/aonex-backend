// Catalog-RAG retrieval (Amazon "CatalogRAG" pattern): ground enrichment in the
// merchant's OWN catalog by retrieving already-enriched, similar products and
// showing them to the model as few-shot examples. This teaches the SHAPE of good
// attributes for a node (which fields matter, how values are written) without
// inventing facts — the verifier still checks the generated values against the
// target product's own text.
//
// Pure: the corpus is injected. No DB, no embeddings (lexical for now; swap for
// pgvector when the catalog is large — see attribute_embeddings, ADR-006).

import { jaccard, normalizeText, tokenSet } from "./text.js";
import type { CatalogEntry, RagExample } from "./types.js";

/** First path segment of a slug node id, e.g. "fashion/clothing/jeans" -> "fashion". */
export function departmentOf(nodeId: string | undefined): string | undefined {
  if (!nodeId) return undefined;
  const seg = nodeId.split("/")[0];
  return seg || undefined;
}

export interface RetrieveQuery {
  title?: string;
  brand?: string;
  nodeId?: string;
}

export interface RetrieveOptions {
  /** Max examples to return (default 3). */
  k?: number;
  /** Minimum score to include an example (default 0.15 — filters near-irrelevant rows). */
  minScore?: number;
}

interface Scored {
  entry: CatalogEntry;
  score: number;
}

function scoreEntry(q: RetrieveQuery, qTokens: Set<string>, e: CatalogEntry): number {
  // An example with no attributes teaches nothing — drop it.
  if (!e.attrs || Object.keys(e.attrs).length === 0) return 0;
  // Never retrieve the query product itself (title match) — would leak the answer.
  if (q.title && normalizeText(q.title) === normalizeText(e.title)) return 0;

  let score = jaccard(qTokens, tokenSet(e.title)) * 0.6;
  if (q.nodeId && e.nodeId) {
    if (e.nodeId === q.nodeId) score += 1.0;
    else if (departmentOf(e.nodeId) === departmentOf(q.nodeId)) score += 0.4;
  }
  if (q.brand && e.brand && normalizeText(q.brand) === normalizeText(e.brand)) score += 0.2;
  return score;
}

/** Retrieve up to k most-similar catalog entries as few-shot examples. */
export function retrieveExamples(
  query: RetrieveQuery,
  corpus: CatalogEntry[],
  opts: RetrieveOptions = {}
): RagExample[] {
  const k = opts.k ?? 3;
  const minScore = opts.minScore ?? 0.15;
  const qTokens = tokenSet(`${query.title ?? ""} ${query.brand ?? ""}`);

  const scored: Scored[] = corpus
    .map((entry) => ({ entry, score: scoreEntry(query, qTokens, entry) }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return scored.map((s) => ({
    title: s.entry.title,
    ...(s.entry.brand ? { brand: s.entry.brand } : {}),
    attrs: s.entry.attrs,
    ...(s.entry.nodeId ? { nodeId: s.entry.nodeId } : {}),
  }));
}
