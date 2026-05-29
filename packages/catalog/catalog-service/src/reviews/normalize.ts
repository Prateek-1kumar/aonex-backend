// Phase 4 Task 8: normalize raw review payloads into stable records with
// stable dedupe keys, so cross-source re-imports of the same review collapse.

import { createHash } from "node:crypto";

export interface RawReview {
  source: string;
  author?: string;
  rating: number;
  text?: string;
  date?: string;
}

export interface NormalizedReview {
  source: string;
  author: string | null;
  rating: number;
  body: string | null;
  reviewedAt: string | null;
  dedupeKey: string;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Stable hash of `(source, author, text)` after whitespace + case normalization.
 *  Re-importing "Sam P." vs "sam p." with the same text dedupes to ONE row. */
export function dedupeKey(source: string, author: string, text: string): string {
  return createHash("sha1")
    .update(`${norm(source)}|${norm(author)}|${norm(text)}`)
    .digest("hex");
}

export function normalizeReview(r: RawReview): NormalizedReview {
  return {
    source: r.source,
    author: r.author ?? null,
    rating: r.rating,
    body: r.text ?? null,
    reviewedAt: r.date ?? null,
    dedupeKey: dedupeKey(r.source, r.author ?? "", r.text ?? ""),
  };
}
