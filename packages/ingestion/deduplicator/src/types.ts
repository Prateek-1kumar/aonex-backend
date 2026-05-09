// HLD §13 / §20 — Deduplicator decision types.

import type { ProductId } from "@aonex/types";

export type DedupeDecision =
  | { kind: "new" }
  | { kind: "merge"; productId: ProductId; reason: "gtin_match" | "mpn_match" }
  | { kind: "review"; candidates: ProductId[]; reason: string }
  | { kind: "conflict"; existingProductId: ProductId; reason: string };

/** Minimal product shape the deduplicator needs — pure data, no DB */
export interface ExistingProduct {
  id: ProductId;
  gtin: string | null;
  brand: string | null;
  modelNumber: string | null;
  title: string;
  canonicalCategory: string | null;
}

/** Candidate fields extracted from the incoming artifact */
export interface DedupeCandidate {
  gtin: string | null;
  brand: string | null;
  modelNumber: string | null;
  title: string;
  canonicalCategory: string | null;
}
