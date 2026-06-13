// Identity resolver: given an observation + identity hint, find an existing
// catalog_products row to attach to (gtin → mpn+brand → primary_id → fuzzy),
// or return null so the caller creates a new product.
// Pure query — emits NO side effects; the write path materialises review tasks/events.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { TenantId } from "@aonex/types";
import { computeMatchScore } from "@aonex/multi-source-reconciler";

/** Threshold above which a fuzzy match auto-resolves. */
const FUZZY_AUTO_MATCH = 0.7;
/** Threshold above which a fuzzy candidate triggers a review (but no match). */
const FUZZY_REVIEW = 0.5;
/**
 * Max brand-matched rows pulled into the in-JS fuzzy scorer. Bounds the scan
 * for high-volume brands; candidates are pre-ordered by trigram title
 * similarity so the best composite match is overwhelmingly within this cap.
 */
const FUZZY_CANDIDATE_LIMIT = 500;

export interface IdentityHint {
  gtin?: string;
  mpn?: string;
  brand?: string;
  /** Title to score against existing candidate titles in the fuzzy path. */
  titleForFuzzy?: string;
  /** Merchant-supplied SKU. When present, resolution is exact-or-none (fuzzy
   *  is skipped — a merchant-keyed product is either its own prior key or new). */
  primary_identifier?: string;
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
  /**
   * When true, also search staged_products (status='pending') and include
   * those matches in `candidates` tagged kind='staged'. Default false keeps
   * the resolver backward-compatible with the catalog-write path.
   */
  includeStaged?: boolean;
}

export type IdentityMatchPath =
  | "gtin"
  | "mpn_brand"
  | "primary_id"
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
  /**
   * All matches considered, tagged by origin. Empty unless includeStaged or a
   * live match was found. Used by admitOrStage to route the ingest: a live
   * entry means enrich, a staged entry means accumulate, empty means hold.
   */
  candidates: Array<{ productId: string; score: number; kind: "live" | "staged" }>;
}

/**
 * Resolve an incoming observation against the catalog_products table.
 * See the module header for the resolution-path algorithm.
 */
export async function resolveIdentity(
  input: IdentityResolverInput
): Promise<IdentityResolverResult> {
  const { db, tenantId, identityHint } = input;
  const candidateIds: string[] = [];

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
        candidateProductIds: [hit.productId],
        candidates: [{ productId: hit.productId, score: 1.0, kind: "live" }]
      };
    }
  }

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
        candidateProductIds: [hit.productId],
        candidates: [{ productId: hit.productId, score: 0.9, kind: "live" }]
      };
    }
  }

  // A merchant SKU resolves EXACT-OR-NONE and deliberately skips fuzzy: CSV
  // SKUs share one brand with near-identical synthetic titles, so fuzzy scoring
  // would merge distinct pieces.
  if (identityHint.primary_identifier) {
    const rows = await db
      .select({ productId: schema.catalogProducts.productId })
      .from(schema.catalogProducts)
      .where(
        and(
          eq(schema.catalogProducts.tenantId, tenantId),
          eq(schema.catalogProducts.primaryIdentifier, identityHint.primary_identifier)
        )
      )
      .limit(1);
    const hit = rows[0];
    if (hit) {
      return {
        productId: hit.productId,
        strength: 1.0,
        reviewTaskSuggested: false,
        matchPath: "primary_id",
        candidateProductIds: [hit.productId],
        candidates: [{ productId: hit.productId, score: 1.0, kind: "live" }]
      };
    }
    return {
      productId: null,
      strength: 0,
      reviewTaskSuggested: false,
      matchPath: "none",
      candidateProductIds: [],
      candidates: []
    };
  }

  const fuzzyTitle = input.observationTitle ?? identityHint.titleForFuzzy;
  if (identityHint.brand && fuzzyTitle) {
    const filters = [
      eq(schema.catalogProducts.tenantId, tenantId),
      sql`${schema.catalogProducts.identity}->>'brand' = ${identityHint.brand}`,
      isNotNull(schema.catalogProducts.productId)
    ];
    if (input.inferredFamily) {
      filters.push(eq(schema.catalogProducts.family, input.inferredFamily));
    }

    const candidates = (await db.execute(
      sql`SELECT
            product_id,
            gen_title,
            identity->>'gtin' AS gtin,
            identity->>'mpn'  AS mpn,
            identity->>'brand' AS brand
          FROM catalog_products
          WHERE ${and(...filters)}
            AND status <> 'merged'
          ORDER BY similarity(gen_title, ${fuzzyTitle}) DESC NULLS LAST
          LIMIT ${FUZZY_CANDIDATE_LIMIT}`
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
          candidateProductIds: candidateIds,
          candidates: [{ productId: best.productId, score: best.score, kind: "live" }]
        };
      }
      if (best.score >= FUZZY_REVIEW) {
        return {
          productId: null,
          strength: 0,
          reviewTaskSuggested: true,
          matchPath: "fuzzy_review",
          candidateProductIds: candidateIds,
          candidates: []
        };
      }
    }
  }

  const stagedCandidates: Array<{ productId: string; score: number; kind: "live" | "staged" }> = [];
  if (input.includeStaged && identityHint.gtin) {
    const stagedRows = await db
      .select({ stagedProductId: schema.stagedProducts.stagedProductId })
      .from(schema.stagedProducts)
      .where(
        and(
          eq(schema.stagedProducts.tenantId, tenantId),
          eq(schema.stagedProducts.status, "pending"),
          sql`${schema.stagedProducts.proposedIdentity}->>'gtin' = ${identityHint.gtin}`
        )
      )
      .limit(5);
    for (const row of stagedRows) {
      stagedCandidates.push({ productId: row.stagedProductId, score: 1.0, kind: "staged" });
    }
  }

  return {
    productId: null,
    strength: 0,
    reviewTaskSuggested: false,
    matchPath: "none",
    candidateProductIds: candidateIds,
    candidates: stagedCandidates
  };
}
