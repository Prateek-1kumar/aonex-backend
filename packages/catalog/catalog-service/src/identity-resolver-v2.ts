// Strong-key-or-Lab resolver: wraps the legacy resolveIdentity to also return
// candidate rows with their identifier sets + variant keys, so decideResolution
// can apply the strong-key rule against the full catalog.
// A sibling (not a modification) so legacy callers keep the existing return shape.

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
  /** Unused today — reserved for the follow-on that scopes resolution to a
   *  merchant when connector authority demands it. Accepted now so the call-site
   *  stays stable when that constraint lands. */
  merchantId?: MerchantId;
  adapterOutput: AdapterOutput;
  inferredFamily?: string;
}

/** Per-candidate metadata for the heal-on-touch check. Parallel to
 *  `candidateRows` — same length, same order — so callers can inspect the
 *  old-row signals (pipeline_version, empty identifiers[]) without polluting
 *  the shared `CandidateRow` type used by `decideResolution`. */
export interface CandidateMeta {
  productId: string;
  /** catalog_products.pipeline_version. Pre-v2 rows are 1; new inserts are
   *  stamped 2. */
  pipelineVersion: number;
  /** True when the row's identifiers[] is empty. The heal-on-touch check pairs
   *  this with pipelineVersion<2 to detect a fuzzy match to an old weak-identity
   *  row — the trigger for the heal signal. */
  identifiersEmpty: boolean;
}

export interface ResolveV2Result {
  legacy: IdentityResolverResult;
  candidateRows: CandidateRow[];
  /** Parallel to candidateRows (same length, same order). Carries the v1/empty
   *  signals decideResolution doesn't need. */
  candidateMeta: CandidateMeta[];
}

/** Build a strong-keyed identifier set from a legacy IdentityHint.
 *  defaultSource="link" is a placeholder until per-source authority is threaded
 *  through the adapter contract. */
export function identifierSetFromHint(
  hint: AdapterOutput["identityHint"],
  defaultSource = "link"
): Identifier[] {
  const out: Identifier[] = [];
  if (hint.gtin) out.push({ type: "gtin", value: hint.gtin, source: defaultSource, corroborated: true });
  if (hint.mpn) out.push({ type: "mpn", value: hint.mpn, source: defaultSource, corroborated: true });
  if (hint.primary_identifier)
    out.push({ type: "merchant_sku", value: hint.primary_identifier, source: "csv" });
  return out;
}

/** Run the legacy resolver, then hydrate candidate rows with identifiers +
 *  variant so decideResolution can apply the strong-key rule against the full
 *  catalog (legacy hits ∪ direct identifiers[] containment hits). */
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

  const strongMatchIds = new Set<string>();
  if (incomingStrong.length > 0) {
    const containmentClauses: SQL[] = incomingStrong.map((id) => {
      // Bind the JSON payload as a $N parameter (NOT sql.raw): the driver
      // escapes id.value, avoiding broken literals and a SQL-injection surface
      // for attacker-controlled connector input.
      const containmentJson = JSON.stringify([{ type: id.type, value: id.value }]);
      return sql`${schema.catalogProducts.identifiers} @> ${containmentJson}::jsonb`;
    });
    const where = and(
      eq(schema.catalogProducts.tenantId, input.tenantId),
      or(...containmentClauses) as SQL
    );
    const rows = await input.db
      .select({ productId: schema.catalogProducts.productId })
      .from(schema.catalogProducts)
      .where(where);
    for (const r of rows) strongMatchIds.add(r.productId);
  }

  const liveIds = legacy.candidates
    .filter((c) => c.kind === "live")
    .map((c) => c.productId);
  const allIds = Array.from(new Set<string>([...liveIds, ...strongMatchIds]));
  if (allIds.length === 0) return { legacy, candidateRows: [], candidateMeta: [] };

  const rows = await input.db
    .select({
      productId: schema.catalogProducts.productId,
      identifiers: schema.catalogProducts.identifiers,
      identity: schema.catalogProducts.identity,
      pipelineVersion: schema.catalogProducts.pipelineVersion,
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

  const candidateRows: CandidateRow[] = [];
  const candidateMeta: CandidateMeta[] = [];
  for (const row of rows) {
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
    if (legacyScore !== undefined && legacyScore < 1.0) candidate.fuzzyScore = legacyScore;
    candidateRows.push(candidate);
    candidateMeta.push({
      productId: row.productId,
      pipelineVersion: row.pipelineVersion,
      identifiersEmpty: ids.length === 0,
    });
  }

  return { legacy, candidateRows, candidateMeta };
}
