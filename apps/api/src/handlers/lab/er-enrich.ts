// Phase 4 Task 4: enrich existing match candidates with ER PairScore breakdown
// so reviewers see *why* something is a candidate (titleSim + specAgreement
// + priceProximity → composite).
//
// First pass: scores EXISTING candidates only — we don't search for new ones
// via blocking yet (Phase 4.x). Embeddings are stubbed deterministically per
// the Phase 4 Task 3 pattern; a real embedding provider lands later.

import { scorePair, type PairScore } from "@aonex/multi-source-reconciler";
import { stubEmbedding } from "@aonex/ingestion-eval";

export interface CandidateProductMeta {
  productId: string;
  title: string | null;
  brand: string | null;
  variant: Record<string, string>;
  price: number | null;
}

export interface StagedProductMeta {
  title: string;
  brand: string;
  variant: Record<string, string>;
  price: number | null;
}

/** Score one (staged ↔ candidate) pair using scorePair. Returns null when the
 *  candidate's title is missing (can't compute embedding similarity). */
export function scoreCandidatePair(
  staged: StagedProductMeta,
  candidate: CandidateProductMeta
): PairScore | null {
  if (!candidate.title) return null;
  return scorePair(
    {
      titleEmbedding: stubEmbedding(staged.title),
      specs: staged.variant,
      ...(staged.price !== null ? { price: staged.price } : {}),
    },
    {
      titleEmbedding: stubEmbedding(candidate.title),
      specs: candidate.variant,
      ...(candidate.price !== null ? { price: candidate.price } : {}),
    }
  );
}
