import { jaroWinkler } from "./jaro-winkler.js";

/**
 * Spec §6.8 — composite identity-match score for two product candidates.
 * Weights per the research brief: 40% GTIN exact + 20% MPN exact +
 * 25% title similarity + 15% brand exact. Range 0..1.
 */

export const WEIGHTS = {
  GTIN: 0.40,
  MPN: 0.20,
  TITLE_SIMILARITY: 0.25,
  BRAND_EXACT: 0.15
} as const;

/** Composite score thresholds for reconciliation decisions. */
export const THRESHOLDS = {
  AUTO_MERGE: 0.70,
  REVIEW: 0.40
} as const;

export interface ProductIdentity {
  gtin?: string | null;
  modelNumber?: string | null;
  title?: string | null;
  brand?: string | null;
}

export interface MatchScoreBreakdown {
  /** 1 when both have the same GTIN (case-/whitespace-insensitive); else 0. Null when EITHER is missing. */
  gtin: number | null;
  /** 1 when both have the same MPN/model_number; else 0. Null when EITHER is missing. */
  mpn: number | null;
  /** Jaro-Winkler similarity 0..1 when both titles present; null otherwise. */
  titleSimilarity: number | null;
  /** 1 when brands match case-insensitively; else 0. Null when EITHER is missing. */
  brand: number | null;
  /** Sum of (signal × weight) over available signals, divided by sum-of-weights-of-available-signals. */
  composite: number;
  /** Total weight of available signals (max 1.0 when all 4 are present). */
  signalCoverage: number;
}

const norm = (s: string | null | undefined): string | null => {
  if (s == null) return null;
  const trimmed = s.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
};

const exactNorm = (a: string | null | undefined, b: string | null | undefined): number | null => {
  const na = norm(a);
  const nb = norm(b);
  if (na == null || nb == null) return null;
  return na === nb ? 1 : 0;
};

/**
 * Returns the composite identity score + the per-signal breakdown.
 *
 * Missing signals (null on either side) are excluded from the composite —
 * we divide the weighted-sum by the sum-of-weights-of-available-signals,
 * so a match on title+brand alone can still produce a high composite when
 * GTIN/MPN are unavailable.
 */
export function computeMatchScore(a: ProductIdentity, b: ProductIdentity): MatchScoreBreakdown {
  const gtin = exactNorm(a.gtin, b.gtin);
  const mpn = exactNorm(a.modelNumber, b.modelNumber);
  const ta = norm(a.title);
  const tb = norm(b.title);
  const titleSimilarity = ta == null || tb == null ? null : jaroWinkler(ta, tb);
  const brand = exactNorm(a.brand, b.brand);

  const signals: Array<{ value: number; weight: number }> = [];
  if (gtin != null) signals.push({ value: gtin, weight: WEIGHTS.GTIN });
  if (mpn != null) signals.push({ value: mpn, weight: WEIGHTS.MPN });
  if (titleSimilarity != null) signals.push({ value: titleSimilarity, weight: WEIGHTS.TITLE_SIMILARITY });
  if (brand != null) signals.push({ value: brand, weight: WEIGHTS.BRAND_EXACT });

  const signalCoverage = signals.reduce((s, x) => s + x.weight, 0);
  const composite = signalCoverage === 0
    ? 0
    : signals.reduce((s, x) => s + x.value * x.weight, 0) / signalCoverage;

  return { gtin, mpn, titleSimilarity, brand, composite, signalCoverage };
}
