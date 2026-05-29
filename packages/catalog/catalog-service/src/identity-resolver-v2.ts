// Phase 2: strong-key-or-Lab resolver (spec D2). Wraps the legacy resolveIdentity
// to ALSO return candidate rows with their identifier sets + variant keys, so
// decideResolution (Task 5) can apply the strong-key-or-Lab rule against the
// FULL catalog — not just the rows the legacy GTIN/MPN/fuzzy paths happened to
// surface.
//
// Why a sibling and not a modification of resolveIdentity?
//   - Legacy callers (writeAdapterOutput, promote-staged) depend on the existing
//     return shape. Changing it would force a multi-file cascade with risk of
//     regression. The sibling lets admit-or-stage upgrade in isolation while
//     every other caller stays on the legacy contract.
//
// Two-source candidate strategy:
//   1. Legacy resolveIdentity surfaces matches via identity.gtin / mpn+brand /
//      primary_identifier / fuzzy title — all the pre-Phase-2 paths.
//   2. We ALSO query catalog_products.identifiers (jsonb @>) directly for any
//      row that already claims one of the incoming STRONG identifiers. Phase 2
//      products carry identifiers in this jsonb column (the GIN jsonb_path_ops
//      index serves the containment query in O(log n)) and may not have the
//      legacy identity.* mirror — so without this second query a strong-key
//      match would be missed and a duplicate created.
//
// Variant extraction is minimal: read identity.variantAxes when present, else
// {}. The values jsonb may carry per-attribute observations of variant axes,
// but Phase 2 will populate identity.variantAxes directly via the Phase 2
// identity-policy work. {} is the safe forward-compatible default.

import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { schema, type DrizzleClient } from "@aonex/db";
import type { AdapterOutput } from "@aonex/catalog-source-adapters";
import type { TenantId, MerchantId } from "@aonex/types";
import { resolveIdentity, type IdentityResolverResult } from "./identity-resolver.js";
import type { CandidateRow } from "./identity/resolve-v2.js";
import { strongKeys, type Identifier } from "./identity/identifier-set.js";

export interface ResolveV2Input {
  db: DrizzleClient;
  tenantId: TenantId;
  /** Unused today — reserved for the Phase 2 follow-on that scopes resolution
   *  to a merchant when the connector authority demands it. Accepted now so
   *  the v2 call-site stays stable when that constraint lands. */
  merchantId?: MerchantId;
  adapterOutput: AdapterOutput;
  inferredFamily?: string;
}

export interface ResolveV2Result {
  legacy: IdentityResolverResult;
  candidateRows: CandidateRow[];
}

/** Build a strong-keyed identifier set from a legacy IdentityHint.
 *  defaultSource="link" is a placeholder until Phase 2 Task 12 threads
 *  per-source authority through the adapter contract. */
export function identifierSetFromHint(
  hint: AdapterOutput["identityHint"],
  defaultSource = "link"
): Identifier[] {
  const out: Identifier[] = [];
  if (hint.gtin) out.push({ type: "gtin", value: hint.gtin, source: defaultSource, corroborated: true });
  if (hint.mpn) out.push({ type: "mpn", value: hint.mpn, source: defaultSource, corroborated: true });
  if (hint.primary_identifier)
    out.push({ type: "merchant_sku", value: hint.primary_identifier, source: "csv" });
  // asin/shopify_gid/ebay_id are not on the legacy hint; Phase 2 Task 12 will
  // add a richer hint with per-namespace identifiers.
  return out;
}

/** Run the legacy resolver, then hydrate candidate rows with identifiers +
 *  variant so decideResolution can apply the strong-key-or-Lab rule against
 *  the full catalog (legacy hits ∪ direct identifiers[] containment hits). */
export async function resolveIdentityV2(input: ResolveV2Input): Promise<ResolveV2Result> {
  const legacy = await resolveIdentity({
    db: input.db,
    tenantId: input.tenantId,
    identityHint: input.adapterOutput.identityHint,
    ...(input.adapterOutput.identityHint.titleForFuzzy !== undefined
      ? { observationTitle: input.adapterOutput.identityHint.titleForFuzzy }
      : {}),
    ...(input.inferredFamily !== undefined ? { inferredFamily: input.inferredFamily } : {}),
    includeStaged: true,
  });

  const incomingStrong = strongKeys(identifierSetFromHint(input.adapterOutput.identityHint));

  // Phase 2: also surface candidates whose identifiers[] jsonb already claims
  // any incoming strong key. This is the path that catches "seeded with new
  // identifiers shape, no legacy identity.gtin mirror" — without it, the
  // strong-key auto_merge can never fire for Phase 2-only products.
  const strongMatchIds = new Set<string>();
  if (incomingStrong.length > 0) {
    const containmentClauses: SQL[] = incomingStrong.map((id) => {
      // Bind the JSON payload as a $N parameter (NOT sql.raw) so the driver
      // escapes single quotes in id.value. sql.raw with JSON.stringify would
      // break on values like MPN "O'Brien-12" (broken SQL literal) or, worse,
      // open a SQL-injection surface for attacker-controlled connector input.
      const containmentJson = JSON.stringify([{ type: id.type, value: id.value }]);
      return sql`${schema.catalogProducts.identifiers} @> ${containmentJson}::jsonb`;
    });
    const where = and(
      eq(schema.catalogProducts.tenantId, input.tenantId),
      // Drizzle's or() returns SQL | undefined; the length>0 guard above means
      // containmentClauses is non-empty so or() is defined — assert via cast.
      or(...containmentClauses) as SQL
    );
    const rows = await input.db
      .select({ productId: schema.catalogProducts.productId })
      .from(schema.catalogProducts)
      .where(where);
    for (const r of rows) strongMatchIds.add(r.productId);
  }

  // Merge legacy live candidates ∪ strong-match candidates (dedup by productId).
  // Staged candidates from legacy are NOT hydrated — they're not in
  // catalog_products and decideResolution operates on live rows only.
  const liveIds = legacy.candidates
    .filter((c) => c.kind === "live")
    .map((c) => c.productId);
  const allIds = Array.from(new Set<string>([...liveIds, ...strongMatchIds]));
  if (allIds.length === 0) return { legacy, candidateRows: [] };

  const rows = await input.db
    .select({
      productId: schema.catalogProducts.productId,
      identifiers: schema.catalogProducts.identifiers,
      identity: schema.catalogProducts.identity,
    })
    .from(schema.catalogProducts)
    .where(
      and(
        eq(schema.catalogProducts.tenantId, input.tenantId),
        inArray(schema.catalogProducts.productId, allIds)
      )
    );

  const legacyScoreById = new Map<string, number>(
    legacy.candidates.filter((c) => c.kind === "live").map((c) => [c.productId, c.score])
  );

  const candidateRows: CandidateRow[] = rows.map((row) => {
    const ids: Identifier[] = Array.isArray(row.identifiers)
      ? (row.identifiers as Identifier[])
      : [];
    const identityObj =
      row.identity && typeof row.identity === "object"
        ? (row.identity as Record<string, unknown>)
        : {};
    const va = identityObj["variantAxes"];
    const variant: Record<string, string> =
      va && typeof va === "object" && !Array.isArray(va)
        ? (va as Record<string, string>)
        : {};
    const candidate: CandidateRow = { productId: row.productId, ids, variant };
    const legacyScore = legacyScoreById.get(row.productId);
    // Only set fuzzyScore when legacy returned a sub-1.0 (truly fuzzy) score.
    // Strong-match-only rows (no legacy hit) get no fuzzyScore: they rely on
    // matchOnStrong inside decideResolution to drive auto_merge.
    if (legacyScore !== undefined && legacyScore < 1.0) candidate.fuzzyScore = legacyScore;
    return candidate;
  });

  return { legacy, candidateRows };
}
