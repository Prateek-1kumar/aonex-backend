// Anomaly Lab HTTP handlers — thin wrappers over @aonex/catalog-service staging fns.
import type { Context } from "hono";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@aonex/db";
import { TenantId, MerchantId } from "@aonex/types";
import {
  promoteStagedProduct,
  rejectStagedProduct,
  linkStagedProduct,
  StillIncompleteError,
} from "@aonex/catalog-service";
import type { AnomalyLabRouteDeps } from "../routes/anomaly-lab.js";
import {
  scoreCandidatePair,
  type CandidateProductMeta,
  type StagedProductMeta,
} from "./lab/er-enrich.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Extract reviewer ID from the request context.
 * JWT middleware sets merchantId; userId is set by some auth paths.
 * Mirrors review.ts convention.
 */
function getReviewerId(c: Context): string {
  return (
    (c.get("userId" as never) as string | undefined) ??
    MerchantId.unsafeFrom(c.get("merchantId" as never) as string)
  );
}

/**
 * Map a domain error to a structured HTTP response. All action endpoints share
 * this mapping:
 *   StillIncompleteError      → 400 INCOMPLETE (with stillMissing array)
 *   /not pending/i            → 409 CONFLICT
 *   /not found/i              → 404 NOT_FOUND
 *   /not a live candidate/i   → 400 BAD_REQUEST
 *   else                      → 500 INTERNAL
 *
 * IMPORTANT: err.message is logged server-side (below) but NEVER returned to
 * the client — domain messages embed internal IDs (tenantId, stagedProductId,
 * status) that must not leak to API consumers.
 */
function mapDomainError(c: Context, err: unknown): Response {
  if (err instanceof StillIncompleteError) {
    // stillMissing contains only field names — not sensitive; return as-is.
    return c.json(
      {
        error: {
          code: "INCOMPLETE",
          message: "Still missing required fields",
          stillMissing: err.stillMissing,
        },
      },
      400
    );
  }
  if (err instanceof Error) {
    if (/not pending/i.test(err.message)) {
      return c.json(
        { error: { code: "CONFLICT", message: "Staged product is no longer pending (already resolved)" } },
        409
      );
    }
    if (/not found/i.test(err.message)) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Staged product not found" } },
        404
      );
    }
    if (/not a live candidate/i.test(err.message)) {
      return c.json(
        { error: { code: "BAD_REQUEST", message: "Confirmed product is not a candidate for this staged product" } },
        400
      );
    }
  }
  // Log the real error server-side so operators can diagnose; never return it.
  console.error("[lab] unmapped domain error:", err);
  return c.json({ error: { code: "INTERNAL", message: "Internal error" } }, 500);
}

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
      denormTitle: schema.stagedProducts.denormTitle,
      denormBrand: schema.stagedProducts.denormBrand,
      denormPrice: schema.stagedProducts.denormPrice,
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

  // Build staged-side meta once for ER pair scoring. Variant axes aren't
  // denormalized on staged_products today — Phase 4.x will extract them from
  // observations. Passing {} keeps the score honest (neutral specAgreement).
  const stagedTitle = row.denormTitle ?? "";
  const stagedMeta: StagedProductMeta = {
    title: stagedTitle,
    brand: row.denormBrand ?? "",
    variant: {},
    price: row.denormPrice !== null && row.denormPrice !== undefined
      ? Number(row.denormPrice)
      : null,
  };
  // Skip scoring entirely when the staged side has no title — embeddings of
  // empty strings degenerate (zero vector), and the resulting score is noise.
  const canScore = stagedTitle.length > 0;

  // Enrich candidates — non-live entries get null title/brand.
  // For live candidates, attach a PairScore breakdown so reviewers see *why*.
  const enrichedCandidates = candidates.map((cand) => {
    if (cand.kind === "live") {
      const enrichment = liveCandidateMap.get(cand.productId) ?? { title: null, brand: null };
      let pairScore = null;
      if (canScore) {
        // Variant/price not loaded for live candidates today — Phase 4.x adds
        // the join. Passing {} and null biases the composite conservatively.
        const candidateMeta: CandidateProductMeta = {
          productId: cand.productId,
          title: enrichment.title,
          brand: enrichment.brand,
          variant: {},
          price: null,
        };
        pairScore = scoreCandidatePair(stagedMeta, candidateMeta);
      }
      return { ...cand, title: enrichment.title, brand: enrichment.brand, pairScore };
    }
    return { ...cand, title: null, brand: null, pairScore: null };
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

// ── Action schemas ─────────────────────────────────────────────────────────

const ApproveStagedSchema = z.object({
  fills: z.record(z.unknown()).default({}),
});

const LinkStagedSchema = z.object({
  confirmedProductId: z.string().min(1),
  fills: z.record(z.unknown()).default({}),
});

// ── Action handlers ────────────────────────────────────────────────────────

/**
 * POST /api/lab/staged/:id/approve
 *
 * Promote a pending staged product into the catalog. The reviewer's `fills`
 * are merged with the staged observations to satisfy the readiness gate.
 * Returns { data: { productId } } on success.
 */
export async function approveStaged(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const stagedProductId = c.req.param("id") as string;

  const parsed = ApproveStagedSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_FAILED", message: "Invalid request body" } }, 400);
  }

  const reviewerId = getReviewerId(c);

  try {
    const result = await promoteStagedProduct({
      db: deps.db,
      tenantId,
      stagedProductId,
      resolvedBy: reviewerId,
      fills: parsed.data.fills,
    });
    return c.json({ data: { productId: result.productId } });
  } catch (err) {
    return mapDomainError(c, err);
  }
}

/**
 * POST /api/lab/staged/:id/reject
 *
 * Reject a pending staged product. Terminal — the row is marked rejected
 * and will never be promoted. Returns { data: { ok: true } } on success.
 */
export async function rejectStaged(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const stagedProductId = c.req.param("id") as string;
  const reviewerId = getReviewerId(c);

  try {
    await rejectStagedProduct({
      db: deps.db,
      tenantId,
      stagedProductId,
      resolvedBy: reviewerId,
    });
    return c.json({ data: { ok: true } });
  } catch (err) {
    return mapDomainError(c, err);
  }
}

/**
 * POST /api/lab/staged/:id/link
 *
 * Confirm a live match candidate and enrich the existing catalog product with
 * observations from the staged row. Returns { data: { productId } } on success.
 */
export async function linkStaged(c: Context, deps: AnomalyLabRouteDeps): Promise<Response> {
  const tenantId = TenantId.unsafeFrom(c.get("tenantId" as never) as string);
  const stagedProductId = c.req.param("id") as string;

  const parsed = LinkStagedSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: { code: "VALIDATION_FAILED", message: "Invalid request body" } }, 400);
  }

  const reviewerId = getReviewerId(c);

  try {
    const result = await linkStagedProduct({
      db: deps.db,
      tenantId,
      stagedProductId,
      confirmedProductId: parsed.data.confirmedProductId,
      resolvedBy: reviewerId,
      fills: parsed.data.fills,
    });
    return c.json({ data: { productId: result.productId } });
  } catch (err) {
    return mapDomainError(c, err);
  }
}
