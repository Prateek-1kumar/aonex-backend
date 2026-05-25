// Anomaly Lab HTTP handlers — thin wrappers over @aonex/catalog-service staging fns.
import type { Context } from "hono";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { schema } from "@aonex/db";
import { TenantId } from "@aonex/types";
import type { AnomalyLabRouteDeps } from "../routes/anomaly-lab.js";

const QUEUE_MAX = 100;

export async function listQueue(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  // Clamp to [1, QUEUE_MAX]; the Math.max(1, …) guards ?limit=-1/0/junk
  // (a negative limit would otherwise yield .limit(0) then crash on page[-1]).
  const rawLimit = Number(c.req.query("limit") ?? "50");
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, QUEUE_MAX);
  // TODO(lab): createdAt-only keyset can skip/dup rows sharing a timestamp; for
  // tie-safety use a composite <iso>|<uuid> cursor (see handlers/admin-trace.ts).
  const cursor = c.req.query("cursor"); // ISO createdAt of the last item seen

  const conds = [eq(schema.stagedProducts.tenantId, tenantId), eq(schema.stagedProducts.status, "pending")];
  if (cursor) conds.push(gt(schema.stagedProducts.createdAt, new Date(cursor)));

  const rows = await deps.db
    .select({
      stagedProductId: schema.stagedProducts.stagedProductId,
      denormTitle: schema.stagedProducts.denormTitle,
      denormBrand: schema.stagedProducts.denormBrand,
      denormPrice: schema.stagedProducts.denormPrice,
      denormCurrency: schema.stagedProducts.denormCurrency,
      sourceKind: schema.stagedProducts.sourceKind,
      gateVerdict: schema.stagedProducts.gateVerdict,
      matchCandidates: schema.stagedProducts.matchCandidates,
      createdAt: schema.stagedProducts.createdAt,
    })
    .from(schema.stagedProducts)
    .where(and(...conds))
    .orderBy(asc(schema.stagedProducts.createdAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1]!.createdAt.toISOString() : null;

  const items = page.map((r) => {
    const verdict = (r.gateVerdict ?? {}) as { missingFields?: string[] };
    const candidates = (r.matchCandidates ?? []) as unknown[];
    return {
      stagedProductId: r.stagedProductId,
      denormTitle: r.denormTitle,
      denormBrand: r.denormBrand,
      denormPrice: r.denormPrice,
      denormCurrency: r.denormCurrency,
      sourceKind: r.sourceKind,
      missingFields: verdict.missingFields ?? [],
      candidateCount: candidates.length,
      createdAt: r.createdAt.toISOString(),
    };
  });
  // {data:...} envelope — the frontend request<> wrapper returns body.data and
  // throws on its absence (src/lib/api.ts). All lab endpoints must wrap.
  return c.json({ data: { items, nextCursor } });
}

export async function queueStats(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const rows = await deps.db
    .select({
      sourceKind: schema.stagedProducts.sourceKind,
      gateVerdict: schema.stagedProducts.gateVerdict,
      createdAt: schema.stagedProducts.createdAt,
    })
    .from(schema.stagedProducts)
    .where(and(eq(schema.stagedProducts.tenantId, tenantId), eq(schema.stagedProducts.status, "pending")));

  const byReason: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byAge = { today: 0, week: 0, older: 0 };
  const now = Date.now();
  for (const r of rows) {
    bySource[r.sourceKind] = (bySource[r.sourceKind] ?? 0) + 1;
    for (const f of ((r.gateVerdict as { missingFields?: string[] })?.missingFields ?? [])) {
      byReason[f] = (byReason[f] ?? 0) + 1;
    }
    const ageDays = (now - r.createdAt.getTime()) / 86_400_000;
    if (ageDays < 1) byAge.today++;
    else if (ageDays < 7) byAge.week++;
    else byAge.older++;
  }
  return c.json({ data: { total: rows.length, byReason, bySource, byAge } });
}

/** Candidate entry as stored in the matchCandidates JSONB column. */
interface MatchCandidate {
  productId: string;
  score: number;
  kind: string;
}

/**
 * GET /api/lab/staged/:id
 *
 * Tenant-scoped full detail for one staged product. Batch-joins titles/brands
 * from catalog_products for candidates with kind === "live". Returns 404 if
 * the row is absent or belongs to another tenant.
 */
export async function getStaged(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const id = c.req.param("id") as string;

  const rows = await deps.db
    .select({
      stagedProductId: schema.stagedProducts.stagedProductId,
      sourceKind: schema.stagedProducts.sourceKind,
      sourceArtifactId: schema.stagedProducts.sourceArtifactId,
      proposedIdentity: schema.stagedProducts.proposedIdentity,
      observations: schema.stagedProducts.observations,
      gateVerdict: schema.stagedProducts.gateVerdict,
      matchCandidates: schema.stagedProducts.matchCandidates,
    })
    .from(schema.stagedProducts)
    .where(
      and(
        eq(schema.stagedProducts.stagedProductId, id),
        eq(schema.stagedProducts.tenantId, tenantId),
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) return c.json({ error: { code: "NOT_FOUND", message: "Staged product not found" } }, 404);

  const verdict = (row.gateVerdict ?? {}) as { missingFields?: string[]; signals?: unknown[] };
  const candidates = (row.matchCandidates ?? []) as MatchCandidate[];

  // Batch-load catalog_products titles for live candidates.
  const liveCandidateIds = candidates
    .filter((cand) => cand.kind === "live")
    .map((cand) => cand.productId);

  // Map productId → { title, brand } for enrichment below.
  const liveCandidateMap = new Map<string, { title: string | null; brand: string | null }>();
  if (liveCandidateIds.length > 0) {
    const catalogRows = await deps.db
      .select({
        productId: schema.catalogProducts.productId,
        winningValues: schema.catalogProducts.winningValues,
        identity: schema.catalogProducts.identity,
      })
      .from(schema.catalogProducts)
      .where(
        and(
          eq(schema.catalogProducts.tenantId, tenantId),
          inArray(schema.catalogProducts.productId, liveCandidateIds)
        )
      );
    for (const cr of catalogRows) {
      const wv = (cr.winningValues ?? {}) as Record<string, unknown>;
      // Confirmed shape from catalog-products-generated.test.ts:
      //   winningValues.title._primary.value
      const titleLeaf = wv["title"] as { _primary?: { value?: string } } | undefined;
      const title = titleLeaf?._primary?.value ?? null;
      const ident = (cr.identity ?? {}) as { brand?: string };
      const brand = ident.brand ?? null;
      liveCandidateMap.set(cr.productId, { title, brand });
    }
  }

  // Enrich candidates — non-live entries get null title/brand.
  const enrichedCandidates = candidates.map((cand) => {
    if (cand.kind === "live") {
      const enrichment = liveCandidateMap.get(cand.productId) ?? { title: null, brand: null };
      return { ...cand, title: enrichment.title, brand: enrichment.brand };
    }
    return { ...cand, title: null, brand: null };
  });

  return c.json({
    data: {
      stagedProductId: row.stagedProductId,
      sourceKind: row.sourceKind,
      sourceArtifactId: row.sourceArtifactId ?? null,
      proposedIdentity: row.proposedIdentity,
      observations: row.observations,
      missingFields: verdict.missingFields ?? [],
      signals: verdict.signals ?? [],
      matchCandidates: enrichedCandidates,
    },
  });
}

/**
 * GET /api/lab/staged/:id/evidence
 *
 * Tenant-scoped raw evidence for one staged product. Loads the source_artifact
 * row and returns its rawData mapped by sourceKind:
 *   - "link" → { kind: "html", content: rawData.htmlSnippet }
 *   - other  → { kind: "json", content: rawData }
 * Returns { kind: "none", content: null } when sourceArtifactId is null.
 * Returns 404 if the staged row is absent or belongs to another tenant.
 *
 * rawData shape for link ingest (confirmed from link-extract.processor.ts):
 *   { url, finalUrl, statusCode, contentType, fetchedAt, htmlSnippet, cleanedTextLength }
 * rawData shape for connector ingest: the raw Nango marketplace product record.
 */
export async function getEvidence(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const id = c.req.param("id") as string;

  // Fetch just what we need from the staged row.
  const stagedRows = await deps.db
    .select({
      sourceKind: schema.stagedProducts.sourceKind,
      sourceArtifactId: schema.stagedProducts.sourceArtifactId,
    })
    .from(schema.stagedProducts)
    .where(
      and(
        eq(schema.stagedProducts.stagedProductId, id),
        eq(schema.stagedProducts.tenantId, tenantId),
      )
    )
    .limit(1);

  const staged = stagedRows[0];
  if (!staged) return c.json({ error: { code: "NOT_FOUND", message: "Staged product not found" } }, 404);

  if (!staged.sourceArtifactId) {
    return c.json({ data: { kind: "none", content: null } });
  }

  // Load the source artifact — tenant-scoped for safety.
  const artifactRows = await deps.db
    .select({
      rawData: schema.sourceArtifacts.rawData,
    })
    .from(schema.sourceArtifacts)
    .where(
      and(
        eq(schema.sourceArtifacts.id, staged.sourceArtifactId),
        eq(schema.sourceArtifacts.tenantId, tenantId),
      )
    )
    .limit(1);

  const artifact = artifactRows[0];
  if (!artifact) {
    // Artifact missing or cross-tenant — treat as no evidence.
    return c.json({ data: { kind: "none", content: null } });
  }

  if (staged.sourceKind === "link") {
    // rawData.htmlSnippet is the truncated HTML string persisted by
    // link-extract.processor.ts (up to 10 000 chars of cleaned HTML).
    const rawData = artifact.rawData as Record<string, unknown>;
    const htmlSnippet = (rawData["htmlSnippet"] as string | undefined) ?? null;
    return c.json({ data: { kind: "html", content: htmlSnippet } });
  }

  // Connector / CSV / other — return the full rawData object.
  // connector/CSV rawData is returned verbatim and is currently unbounded — TODO: cap/summarise large connector payloads (link htmlSnippet is already bounded upstream).
  return c.json({ data: { kind: "json", content: artifact.rawData } });
}
