// Catalog redesign — identity resolver.
//
// Implements spec §18: given an incoming observation and an identity hint
// (gtin / mpn / brand / fuzzy title), find an existing catalog_products row
// to attach to, or return null so the caller knows to create a new one.
//
// Four resolution paths, in order:
//   1. Strong identity:  identity.gtin exact-match              → strength 1.0
//   2. Medium identity:  identity.mpn + identity.brand match    → strength 0.9
//   3. Fuzzy identity:   brand (+ family) candidates scored via
//                        @aonex/multi-source-reconciler          → strength = score
//        score >= 0.7  → match
//        0.5 <= score < 0.7 → null, but reviewTaskSuggested:true
//   4. None             → null
//
// Note: this module does NOT emit review tasks or catalog_events when a
// fuzzy match falls in the review band. It only flags the situation via
// `reviewTaskSuggested`. The caller (Task 3.5 catalog write service) is
// responsible for materialising the review_task / catalog_event row. This
// keeps the resolver a pure query against catalog_products and leaves all
// side-effects to the write path.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";
import { computeMatchScore } from "@aonex/multi-source-reconciler";

/** Threshold above which a fuzzy match auto-resolves. */
const FUZZY_AUTO_MATCH = 0.7;
/** Threshold above which a fuzzy candidate triggers a review (but no match). */
const FUZZY_REVIEW = 0.5;

export interface IdentityHint {
  gtin?: string;
  mpn?: string;
  brand?: string;
  /** Title to score against existing candidate titles in the fuzzy path. */
  titleForFuzzy?: string;
}

export interface IdentityResolverInput {
  db: DrizzleClient;
  tenantId: TenantId;
  identityHint: IdentityHint;
  /**
   * The new observation's title. Used as the source for fuzzy scoring.
   * If absent, falls back to identityHint.titleForFuzzy.
   */
  observationTitle?: string;
  /**
   * Inferred product family (e.g. "phone", "shoe"). When provided, restricts
   * fuzzy candidates to rows with `family = inferredFamily`. When omitted,
   * the family filter is dropped (we still require brand for fuzzy).
   */
  inferredFamily?: string;
}

export type IdentityMatchPath =
  | "gtin"
  | "mpn_brand"
  | "fuzzy_high"
  | "fuzzy_review"
  | "none";

export interface IdentityResolverResult {
  /** Resolved catalog_products.product_id, or null if no confident match. */
  productId: string | null;
  /**
   * Match strength: 1.0 for GTIN, 0.9 for MPN+brand, the composite score for
   * fuzzy matches (>= 0.7), or 0 when no match / review-only.
   */
  strength: number;
  /** True when a fuzzy candidate scored between 0.5 and 0.7 (no auto-match). */
  reviewTaskSuggested: boolean;
  matchPath: IdentityMatchPath;
  /** All candidate product_ids considered (for debugging/observability). */
  candidateProductIds: string[];
}

/**
 * Resolve an incoming observation against the catalog_products table.
 * See module header for the algorithm; see spec §18 for the source of truth.
 */
export async function resolveIdentity(
  input: IdentityResolverInput
): Promise<IdentityResolverResult> {
  const { db, tenantId, identityHint } = input;
  const candidateIds: string[] = [];

  // ---- 1. Strong identity: GTIN exact match -----------------------------
  if (identityHint.gtin) {
    const rows = await db
      .select({ productId: schema.catalogProducts.productId })
      .from(schema.catalogProducts)
      .where(
        and(
          eq(schema.catalogProducts.tenantId, tenantId),
          sql`${schema.catalogProducts.identity}->>'gtin' = ${identityHint.gtin}`
        )
      )
      .limit(1);
    const hit = rows[0];
    if (hit) {
      return {
        productId: hit.productId,
        strength: 1.0,
        reviewTaskSuggested: false,
        matchPath: "gtin",
        candidateProductIds: [hit.productId]
      };
    }
  }

  // ---- 2. Medium identity: MPN + brand exact match ----------------------
  if (identityHint.mpn && identityHint.brand) {
    const rows = await db
      .select({ productId: schema.catalogProducts.productId })
      .from(schema.catalogProducts)
      .where(
        and(
          eq(schema.catalogProducts.tenantId, tenantId),
          sql`${schema.catalogProducts.identity}->>'mpn' = ${identityHint.mpn}`,
          sql`${schema.catalogProducts.identity}->>'brand' = ${identityHint.brand}`
        )
      )
      .limit(1);
    const hit = rows[0];
    if (hit) {
      return {
        productId: hit.productId,
        strength: 0.9,
        reviewTaskSuggested: false,
        matchPath: "mpn_brand",
        candidateProductIds: [hit.productId]
      };
    }
  }

  // ---- 3. Fuzzy identity: brand (+ family) candidates scored ------------
  // Fuzzy needs a brand AND a title to score against — without either, skip
  // straight to "no match" rather than scanning the whole tenant.
  const fuzzyTitle = input.observationTitle ?? identityHint.titleForFuzzy;
  if (identityHint.brand && fuzzyTitle) {
    const filters = [
      eq(schema.catalogProducts.tenantId, tenantId),
      sql`${schema.catalogProducts.identity}->>'brand' = ${identityHint.brand}`,
      // Avoid scoring against tombstones/merged rows.
      isNotNull(schema.catalogProducts.productId)
    ];
    if (input.inferredFamily) {
      filters.push(eq(schema.catalogProducts.family, input.inferredFamily));
    }

    // gen_title is the generated column projecting winning_values.title._primary.value;
    // it's the cheapest title source and is what the trigram index covers.
    const candidates = (await db.execute(
      sql`SELECT
            product_id,
            gen_title,
            identity->>'gtin' AS gtin,
            identity->>'mpn'  AS mpn,
            identity->>'brand' AS brand
          FROM catalog_products
          WHERE ${and(...filters)}
            AND status <> 'merged'`
    )).rows as Array<{
      product_id: string;
      gen_title: string | null;
      gtin: string | null;
      mpn: string | null;
      brand: string | null;
    }>;

    let best: { productId: string; score: number } | null = null;
    for (const c of candidates) {
      candidateIds.push(c.product_id);
      const breakdown = computeMatchScore(
        {
          gtin: identityHint.gtin ?? null,
          modelNumber: identityHint.mpn ?? null,
          title: fuzzyTitle,
          brand: identityHint.brand ?? null
        },
        {
          gtin: c.gtin,
          modelNumber: c.mpn,
          title: c.gen_title,
          brand: c.brand
        }
      );
      if (!best || breakdown.composite > best.score) {
        best = { productId: c.product_id, score: breakdown.composite };
      }
    }

    if (best) {
      if (best.score >= FUZZY_AUTO_MATCH) {
        return {
          productId: best.productId,
          strength: best.score,
          reviewTaskSuggested: false,
          matchPath: "fuzzy_high",
          candidateProductIds: candidateIds
        };
      }
      if (best.score >= FUZZY_REVIEW) {
        return {
          productId: null,
          strength: 0,
          reviewTaskSuggested: true,
          matchPath: "fuzzy_review",
          candidateProductIds: candidateIds
        };
      }
    }
  }

  // ---- 4. No match ------------------------------------------------------
  return {
    productId: null,
    strength: 0,
    reviewTaskSuggested: false,
    matchPath: "none",
    candidateProductIds: candidateIds
  };
}
