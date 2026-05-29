// Phase 4 Task 3: ER eval gate. Runs blocking + multi-feature scorePair
// over labeled identity pairs and compares to the jaro-winkler baseline.
//
// Embeddings are stubbed deterministically (token-hash to fixed-dim) — Phase 4.x
// wires a real embedding provider once one is selected and the eval set grows
// beyond Phase 2's 2 seed pairs.

import { scorePair } from "@aonex/multi-source-reconciler";
import type { IdentityPair } from "./merge-pairs.js";

export const ER_PRECISION_BAR = 0.9;
export const ER_RECALL_BAR    = 0.7;
export const ER_MERGE_THRESHOLD = 0.7; // composite >= this → ER would auto-merge

/** Deterministic stub embedding: hash each normalized token into a fixed-dim
 *  vector. Default dim=64 keeps token-bucket collisions rare enough that
 *  distinct multi-token titles (e.g. "Samsung Galaxy S25" vs "Apple iPhone 17")
 *  do not artificially collide and inflate cosine similarity.
 *  Not a real semantic embedding — but reproducible across runs and good enough
 *  for the wiring + test. Phase 4.x swaps in a real provider. */
export function stubEmbedding(title: string, dim = 64): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  for (const tok of tokens) {
    let h = 0;
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
    vec[h % dim]! += 1;
  }
  // L2-normalize so cosine sim works
  const len = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return len > 0 ? vec.map((v) => v / len) : vec;
}

export interface ErEvalSide {
  title: string;
  specs: Record<string, string>;
  price?: number;
  brand?: string;
}

/** ER would auto-merge iff scorePair's composite clears the threshold. */
export function wouldErAutoMerge(a: ErEvalSide, b: ErEvalSide): boolean {
  const score = scorePair(
    { titleEmbedding: stubEmbedding(a.title), specs: a.specs, ...(a.price !== undefined ? { price: a.price } : {}) },
    { titleEmbedding: stubEmbedding(b.title), specs: b.specs, ...(b.price !== undefined ? { price: b.price } : {}) }
  );
  return score.composite >= ER_MERGE_THRESHOLD;
}

export interface ErMetrics {
  total: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number;
  recall: number;
}

/** Compute precision/recall of the ER merge decision over labeled pairs. */
export function erMetrics(pairs: IdentityPair[], pairToSides: (p: IdentityPair) => [ErEvalSide, ErEvalSide]): ErMetrics {
  let truePositive = 0, falsePositive = 0, falseNegative = 0;
  for (const p of pairs) {
    const [a, b] = pairToSides(p);
    const erMerges = wouldErAutoMerge(a, b);
    if (erMerges && p.label === "same")      truePositive++;
    if (erMerges && p.label === "different") falsePositive++;
    if (!erMerges && p.label === "same")     falseNegative++;
  }
  const precision = truePositive + falsePositive === 0 ? 1 : truePositive / (truePositive + falsePositive);
  const recall    = truePositive + falseNegative === 0 ? 1 : truePositive / (truePositive + falseNegative);
  return { total: pairs.length, truePositive, falsePositive, falseNegative, precision, recall };
}

/** Build ErEvalSide tuples from an IdentityPair. The labeled-pair fixture stores
 *  identifiers + variant; we use the first identifier's `value` as a synthetic
 *  title token plus the variant axes as specs. Stub-friendly. */
export function defaultPairToSides(p: IdentityPair): [ErEvalSide, ErEvalSide] {
  const mk = (side: IdentityPair["a"]): ErEvalSide => ({
    title: side.identifiers[0]?.value ?? "",
    specs: side.variant,
  });
  return [mk(p.a), mk(p.b)];
}
