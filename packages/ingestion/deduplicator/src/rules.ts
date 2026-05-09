// HLD §13 — deduplication rules. Pure function. No DB.
// Conservative: never auto-merge on title alone.
// All five rules per spec §6 Module 6.

import type { DedupeCandidate, DedupeDecision, ExistingProduct } from "./types.js";
import { normalizedSimilarity } from "./similarity.js";

const TITLE_SIMILARITY_THRESHOLD = 0.92; // HLD §13

/** Normalize a GTIN: strip leading zeros, whitespace, dashes */
function normalizeGtin(g: string | null): string | null {
  if (!g) return null;
  return g.replace(/[\s\-]/g, "").replace(/^0+/, "") || null;
}

function normalizeBrand(b: string | null): string | null {
  return b ? b.toLowerCase().trim() : null;
}

function normalizeMpn(m: string | null): string | null {
  return m ? m.toLowerCase().trim() : null;
}

function categoriesCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return true; // unknown = compatible (conservative)
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

/**
 * HLD §13 — deduplicate a candidate against existing products.
 * Rules applied in priority order:
 *
 * 1. Same GTIN + same tenant:
 *    - Category conflict OR brand mismatch → review
 *    - Otherwise → merge
 * 2. Conflicting GTIN → conflict (never merge)
 * 3. Same brand + same MPN AND title similarity ≥ 0.92 AND category compatible → merge
 * 4. Title similarity ≥ 0.92 with no GTIN/MPN identifier → review
 * 5. Different category with GTIN → conflict
 *
 * @param candidate - incoming product facts
 * @param existing - all existing products for the tenant (loaded by the worker)
 */
export function dedupe(
  candidate: DedupeCandidate,
  existing: ExistingProduct[]
): DedupeDecision {
  const candidateGtin = normalizeGtin(candidate.gtin);
  const candidateBrand = normalizeBrand(candidate.brand);
  const candidateMpn = normalizeMpn(candidate.modelNumber);

  // Rule 1 & 2: GTIN-based matching
  if (candidateGtin) {
    const gtinMatches = existing.filter(
      (p) => normalizeGtin(p.gtin) === candidateGtin
    );

    // Rule 2: Conflicting GTIN (same GTIN, different product context)
    // Detected when we find a GTIN match but category is incompatible
    const hardConflict = gtinMatches.find(
      (p) =>
        p.canonicalCategory &&
        candidate.canonicalCategory &&
        !categoriesCompatible(p.canonicalCategory, candidate.canonicalCategory)
    );
    if (hardConflict) {
      return {
        kind: "conflict",
        existingProductId: hardConflict.id,
        reason: `GTIN ${candidateGtin} exists under incompatible category "${hardConflict.canonicalCategory}"`
      };
    }

    if (gtinMatches.length === 1) {
      const match = gtinMatches[0]!;
      // Rule 1 sub-rule: review if brand mismatch
      const brandMismatch =
        candidateBrand && normalizeBrand(match.brand) &&
        normalizeBrand(match.brand) !== candidateBrand;
      if (brandMismatch) {
        return {
          kind: "review",
          candidates: [match.id],
          reason: `GTIN match but brand mismatch: existing="${match.brand}", incoming="${candidate.brand}"`
        };
      }
      return { kind: "merge", productId: match.id, reason: "gtin_match" };
    }

    if (gtinMatches.length > 1) {
      return {
        kind: "review",
        candidates: gtinMatches.map((p) => p.id),
        reason: `Multiple products share GTIN ${candidateGtin}`
      };
    }
  }

  // Rule 3: Brand + MPN + title similarity ≥ 0.92 + category compatible
  if (candidateBrand && candidateMpn) {
    const mpnMatches = existing.filter((p) => {
      const brandMatch = normalizeBrand(p.brand) === candidateBrand;
      const mpnMatch = normalizeMpn(p.modelNumber) === candidateMpn;
      const titleSim = normalizedSimilarity(p.title, candidate.title);
      const catOk = categoriesCompatible(p.canonicalCategory, candidate.canonicalCategory);
      return brandMatch && mpnMatch && titleSim >= TITLE_SIMILARITY_THRESHOLD && catOk;
    });

    if (mpnMatches.length === 1) {
      return { kind: "merge", productId: mpnMatches[0]!.id, reason: "mpn_match" };
    }
    if (mpnMatches.length > 1) {
      return {
        kind: "review",
        candidates: mpnMatches.map((p) => p.id),
        reason: "Multiple brand+MPN matches"
      };
    }
  }

  // Rule 4: Title similarity ≥ 0.92 with no strong identifier → review only
  const titleSimilar = existing.filter(
    (p) =>
      normalizedSimilarity(p.title, candidate.title) >= TITLE_SIMILARITY_THRESHOLD &&
      categoriesCompatible(p.canonicalCategory, candidate.canonicalCategory)
  );
  if (titleSimilar.length > 0) {
    return {
      kind: "review",
      candidates: titleSimilar.map((p) => p.id),
      reason: `Title similarity ≥ ${TITLE_SIMILARITY_THRESHOLD} — manual review required (HLD §13)`
    };
  }

  return { kind: "new" };
}
