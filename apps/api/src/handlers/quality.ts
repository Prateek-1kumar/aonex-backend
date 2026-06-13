// Catalog Quality Report — read-only credibility surface.
//
//   GET /catalog/quality?category=<nodeIdPrefix>  -> measured eval headline + regression
//                                                    + live per-catalog aggregate metrics
//   GET /products/:id/quality                      -> per-SKU completeness/grounding/provenance
//
// "Is enrichment working?" answered with numbers: categorization precision/recall
// and a regression count come from the golden-set eval (enrichment_eval_runs); the
// live completeness/grounding/content come from the products' latest proposals.

import type { Context } from "hono";
import { and, eq, desc, like, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import { MerchantId, TenantId } from "@aonex/types";
import type { CatalogRouteDeps } from "../routes/catalog.js";
import { getQualityEvalSection } from "../services/eval-runs-read.js";

function ids(c: Context): { tenantId: string; merchantId: string } {
  return {
    tenantId: TenantId.unsafeFrom(c.get("tenantId" as never) as string),
    merchantId: MerchantId.unsafeFrom(c.get("merchantId" as never) as string),
  };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** GET /catalog/quality — the report. Eval headline + regression from the golden
 *  set; live aggregates from the products' enrichment proposals (optionally scoped
 *  to a category subtree via the node-id prefix). */
export async function getCatalogQuality(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const { tenantId, merchantId } = ids(c);
  const category = c.req.query("category")?.trim();

  const conds = [
    eq(schema.enrichmentProposals.tenantId, tenantId),
    eq(schema.enrichmentProposals.merchantId, merchantId),
  ];
  // Category scope: products whose taxonomy node is at/under the given prefix.
  if (category) conds.push(like(schema.catalogProducts.categoryNodeId, `${category}%`));

  // Live aggregate over the products' proposals. v1 averages all ready/applied
  // proposals (in practice one per product); good enough for a headline strip.
  const [agg] = await deps.db
    .select({
      enrichedProducts: sql<string>`count(distinct ${schema.enrichmentProposals.productId})`,
      avgCompleteness: sql<string | null>`avg((${schema.enrichmentProposals.scoreAfter}->>'autoApplied')::float)`,
      avgGrounding: sql<string | null>`avg((${schema.enrichmentProposals.scoreAfter}->>'groundingRate')::float)`,
      avgContentQuality: sql<string | null>`avg((${schema.enrichmentProposals.scoreAfter}->>'contentQuality')::float)`,
      pendingReview: sql<string>`count(*) filter (where ${schema.enrichmentProposals.status} = 'ready' and ${schema.enrichmentProposals.reviewedAt} is null)`,
    })
    .from(schema.enrichmentProposals)
    .leftJoin(schema.catalogProducts, eq(schema.catalogProducts.productId, schema.enrichmentProposals.productId))
    .where(and(...conds));

  // Total catalog size in scope (denominator for "X of Y enriched").
  const totalConds = [eq(schema.catalogProducts.tenantId, tenantId), eq(schema.catalogProducts.merchantId, merchantId)];
  if (category) totalConds.push(like(schema.catalogProducts.categoryNodeId, `${category}%`));
  const [totalRow] = await deps.db
    .select({ total: sql<string>`count(*)` })
    .from(schema.catalogProducts)
    .where(and(...totalConds));

  const evalSection = await getQualityEvalSection(deps.db);

  return c.json({
    data: {
      // Measured against the golden set (the credibility headline).
      categorization: evalSection.categorization,
      regression: evalSection.regression,
      groundingRate: evalSection.groundingRate,
      completenessLift: evalSection.completenessLift,
      goldAttrAccuracy: evalSection.goldAttrAccuracy,
      model: evalSection.model,
      asOf: evalSection.asOf,
      // Live, per-this-workspace aggregates.
      catalog: {
        totalProducts: num(totalRow?.total) ?? 0,
        enrichedProducts: num(agg?.enrichedProducts) ?? 0,
        avgCompleteness: num(agg?.avgCompleteness),
        avgGrounding: num(agg?.avgGrounding),
        avgContentQuality: num(agg?.avgContentQuality),
        pendingReview: num(agg?.pendingReview) ?? 0,
      },
    },
  });
}

interface ProposalFieldRow {
  kind?: string;
  grounding?: string;
  accepted?: boolean;
}

/** GET /products/:id/quality — per-SKU breakdown from the latest proposal. */
export async function getProductQuality(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const { tenantId, merchantId } = ids(c);
  const productId = c.req.param("id") as string;

  const [row] = await deps.db
    .select({
      proposalId: schema.enrichmentProposals.proposalId,
      status: schema.enrichmentProposals.status,
      scoreAfter: schema.enrichmentProposals.scoreAfter,
      fields: schema.enrichmentProposals.fields,
      updatedAt: schema.enrichmentProposals.updatedAt,
    })
    .from(schema.enrichmentProposals)
    .where(
      and(
        eq(schema.enrichmentProposals.productId, productId),
        eq(schema.enrichmentProposals.tenantId, tenantId),
        eq(schema.enrichmentProposals.merchantId, merchantId)
      )
    )
    .orderBy(desc(schema.enrichmentProposals.createdAt))
    .limit(1);

  if (!row) {
    return c.json({ data: { enriched: false } });
  }

  const fields = Array.isArray(row.fields) ? (row.fields as ProposalFieldRow[]) : [];
  const specs = fields.filter((f) => (f.kind ?? "spec") === "spec");
  const provenance = { grounded: 0, weak: 0, inferred: 0, unverified: 0, contradicted: 0 } as Record<string, number>;
  for (const f of fields) {
    const g = f.grounding ?? "inferred";
    if (g in provenance) provenance[g]! += 1;
  }
  const score = (row.scoreAfter ?? {}) as Record<string, unknown>;

  return c.json({
    data: {
      enriched: true,
      proposalId: row.proposalId,
      status: row.status,
      completeness: num((score as { autoApplied?: unknown }).autoApplied),
      contentQuality: num((score as { contentQuality?: unknown }).contentQuality),
      groundingRate: num((score as { groundingRate?: unknown }).groundingRate),
      provenanceBreakdown: provenance,
      attrsFilled: specs.filter((f) => f.accepted).length,
      attrsTotal: specs.length,
      updatedAt: row.updatedAt,
    },
  });
}
