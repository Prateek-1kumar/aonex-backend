// Request handlers for catalog enrichment ("Push to Enrich").
//
//   POST   /products/:id/enrich                     -> 202 { proposalId, jobId }
//   GET    /products/:id/enrich/:proposalId         -> proposal (poll until ready)
//   POST   /products/:id/enrich/:proposalId/apply   -> write accepted fields/candidates
//   POST   /products/:id/enrich/:proposalId/reject  -> mark rejected
//
// Async by design: the LLM job is slow (~10-30s), so start enqueues and returns.

import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { and, eq, desc, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { schema } from "@aonex/db";
import { MerchantId, TenantId, QUEUE, JOB_KIND } from "@aonex/types";
import type { CatalogRouteDeps } from "../routes/catalog.js";
import {
  applyEnrichmentProposal,
  revertEnrichmentProposal,
  EnrichmentApplyError,
  type FieldDecision,
  type CandidateDecisionInput,
} from "../services/enrichment-apply.js";

function ids(c: Context): { tenantId: string; merchantId: string } {
  return {
    tenantId: TenantId.unsafeFrom(c.get("tenantId" as never) as string),
    merchantId: MerchantId.unsafeFrom(c.get("merchantId" as never) as string),
  };
}

export async function startEnrichment(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const { tenantId, merchantId } = ids(c);
  const productId = c.req.param("id") as string;
  const requestId = (c.get("requestId" as never) as string) ?? randomUUID();

  const enrichQueue = deps.queues?.[QUEUE.PRODUCT_ENRICH];
  if (!enrichQueue) {
    return c.json(
      { error: { code: "UNAVAILABLE", message: "Enrichment is not configured" } },
      503
    );
  }

  const prod = await deps.db
    .select({ merchantId: schema.catalogProducts.merchantId })
    .from(schema.catalogProducts)
    .where(and(eq(schema.catalogProducts.productId, productId), eq(schema.catalogProducts.tenantId, tenantId)))
    .limit(1);
  if (!prod[0] || prod[0].merchantId !== merchantId) {
    return c.json({ error: { code: "NOT_FOUND", message: "Product not found" } }, 404);
  }

  const proposalId = randomUUID();
  const jobId = `enrich-${tenantId}-${productId}-${proposalId}`;
  await deps.db.insert(schema.enrichmentProposals).values({
    proposalId,
    tenantId,
    merchantId,
    productId,
    status: "pending",
    jobId,
  });

  await enrichQueue.add(
    JOB_KIND.PRODUCT_ENRICH,
    { tenantId, merchantId, productId, proposalId, requestId },
    { jobId, removeOnComplete: 1000, removeOnFail: 5000 }
  );

  return c.json({ data: { proposalId, jobId, status: "generating" } }, 202);
}

export async function getEnrichmentProposal(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const { tenantId, merchantId } = ids(c);
  const productId = c.req.param("id") as string;
  const proposalId = c.req.param("proposalId") as string;

  const rows = await deps.db
    .select()
    .from(schema.enrichmentProposals)
    .where(
      and(
        eq(schema.enrichmentProposals.proposalId, proposalId),
        eq(schema.enrichmentProposals.tenantId, tenantId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.productId !== productId || row.merchantId !== merchantId) {
    return c.json({ error: { code: "NOT_FOUND", message: "Proposal not found" } }, 404);
  }
  return c.json({ data: row });
}

export async function rejectEnrichment(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const { tenantId, merchantId } = ids(c);
  const productId = c.req.param("id") as string;
  const proposalId = c.req.param("proposalId") as string;

  const updated = await deps.db
    .update(schema.enrichmentProposals)
    .set({ status: "rejected", resolvedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.enrichmentProposals.proposalId, proposalId),
        eq(schema.enrichmentProposals.tenantId, tenantId),
        eq(schema.enrichmentProposals.merchantId, merchantId),
        eq(schema.enrichmentProposals.productId, productId),
        inArray(schema.enrichmentProposals.status, ["pending", "generating", "ready"])
      )
    )
    .returning({ id: schema.enrichmentProposals.proposalId });
  if (updated.length === 0) {
    return c.json({ error: { code: "NOT_FOUND", message: "Proposal not found or already resolved" } }, 404);
  }
  return c.json({ data: { ok: true } });
}

export async function applyEnrichment(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const { tenantId, merchantId } = ids(c);
  const productId = c.req.param("id") as string;
  const proposalId = c.req.param("proposalId") as string;

  let body: { fieldDecisions?: unknown; candidateDecisions?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const fieldDecisions = Array.isArray(body.fieldDecisions)
    ? (body.fieldDecisions as FieldDecision[])
    : [];
  const candidateDecisions = Array.isArray(body.candidateDecisions)
    ? (body.candidateDecisions as CandidateDecisionInput[])
    : [];

  try {
    const result = await applyEnrichmentProposal(deps.db, {
      tenantId,
      merchantId,
      productId,
      proposalId,
      fieldDecisions,
      candidateDecisions,
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof EnrichmentApplyError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.httpStatus as 404 | 409);
    }
    throw err;
  }
}

/** POST /catalog/products/:id/enrich/:proposalId/revert — undo an applied enrichment. */
export async function revertEnrichment(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const { tenantId, merchantId } = ids(c);
  const productId = c.req.param("id") as string;
  const proposalId = c.req.param("proposalId") as string;
  try {
    const result = await revertEnrichmentProposal(deps.db, { tenantId, merchantId, productId, proposalId });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof EnrichmentApplyError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.httpStatus as 404 | 409);
    }
    throw err;
  }
}

const BULK_MAX = 50;

/** POST /catalog/enrichment/bulk — enqueue enrichment for up to BULK_MAX products. */
export async function bulkEnrich(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const { tenantId, merchantId } = ids(c);
  const requestId = (c.get("requestId" as never) as string) ?? randomUUID();
  const enrichQueue = deps.queues?.[QUEUE.PRODUCT_ENRICH];
  if (!enrichQueue) {
    return c.json({ error: { code: "UNAVAILABLE", message: "Enrichment is not configured" } }, 503);
  }

  let body: { productIds?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const requested = Array.isArray(body.productIds)
    ? body.productIds.filter((x): x is string => typeof x === "string")
    : [];
  if (requested.length === 0) {
    return c.json({ error: { code: "INVALID_BODY", message: "productIds[] is required" } }, 400);
  }
  const productIds = [...new Set(requested)].slice(0, BULK_MAX);

  const owned = await deps.db
    .select({ id: schema.catalogProducts.productId })
    .from(schema.catalogProducts)
    .where(
      and(
        inArray(schema.catalogProducts.productId, productIds),
        eq(schema.catalogProducts.tenantId, tenantId),
        eq(schema.catalogProducts.merchantId, merchantId)
      )
    );
  const ownedIds = new Set(owned.map((o) => o.id));

  const jobs: { productId: string; proposalId: string; jobId: string }[] = [];
  for (const productId of productIds) {
    if (!ownedIds.has(productId)) continue;
    const proposalId = randomUUID();
    const jobId = `enrich-${tenantId}-${productId}-${proposalId}`;
    await deps.db.insert(schema.enrichmentProposals).values({
      proposalId,
      tenantId,
      merchantId,
      productId,
      status: "pending",
      jobId,
    });
    await enrichQueue.add(
      JOB_KIND.PRODUCT_ENRICH,
      { tenantId, merchantId, productId, proposalId, requestId },
      { jobId, removeOnComplete: 1000, removeOnFail: 5000 }
    );
    jobs.push({ productId, proposalId, jobId });
  }
  return c.json({ data: { jobs } }, 202);
}

/** GET /catalog/enrichment/proposals?status=… — list proposals for the workspace. */
export async function listProposals(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const { tenantId, merchantId } = ids(c);
  const statusParam = c.req.query("status");
  const rawLimit = Number(c.req.query("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 100;

  const reviewedParam = c.req.query("reviewed");
  const conds = [
    eq(schema.enrichmentProposals.tenantId, tenantId),
    eq(schema.enrichmentProposals.merchantId, merchantId),
  ];
  if (statusParam) conds.push(eq(schema.enrichmentProposals.status, statusParam));
  if (reviewedParam === "true") conds.push(isNotNull(schema.enrichmentProposals.reviewedAt));
  else if (reviewedParam === "false") conds.push(isNull(schema.enrichmentProposals.reviewedAt));

  const rows = await deps.db
    .select({
      proposalId: schema.enrichmentProposals.proposalId,
      productId: schema.enrichmentProposals.productId,
      status: schema.enrichmentProposals.status,
      archetype: schema.enrichmentProposals.archetype,
      scoreBefore: schema.enrichmentProposals.scoreBefore,
      scoreAfter: schema.enrichmentProposals.scoreAfter,
      updatedAt: schema.enrichmentProposals.updatedAt,
      reviewedAt: schema.enrichmentProposals.reviewedAt,
      title: sql<string | null>`gen_title`,
      fieldCount: sql<number>`coalesce(jsonb_array_length(${schema.enrichmentProposals.fields}), 0)`,
      candidateCount: sql<number>`coalesce(jsonb_array_length(${schema.enrichmentProposals.candidates}), 0)`,
    })
    .from(schema.enrichmentProposals)
    .leftJoin(
      schema.catalogProducts,
      eq(schema.catalogProducts.productId, schema.enrichmentProposals.productId)
    )
    .where(and(...conds))
    .orderBy(desc(schema.enrichmentProposals.updatedAt))
    .limit(limit);

  return c.json({ data: { proposals: rows } });
}

/** POST /catalog/enrichment/push — stage products into the Drafting Room (no job yet). */
export async function pushProducts(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const { tenantId, merchantId } = ids(c);

  let body: { productIds?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const requested = Array.isArray(body.productIds)
    ? body.productIds.filter((x): x is string => typeof x === "string")
    : [];
  if (requested.length === 0) {
    return c.json({ error: { code: "INVALID_BODY", message: "productIds[] is required" } }, 400);
  }
  const productIds = [...new Set(requested)].slice(0, BULK_MAX);

  const owned = await deps.db
    .select({ id: schema.catalogProducts.productId })
    .from(schema.catalogProducts)
    .where(
      and(
        inArray(schema.catalogProducts.productId, productIds),
        eq(schema.catalogProducts.tenantId, tenantId),
        eq(schema.catalogProducts.merchantId, merchantId)
      )
    );
  const ownedIds = owned.map((o) => o.id);
  if (ownedIds.length === 0) return c.json({ data: { drafts: [] } }, 201);

  // Don't double-stage a product that already has a working-set draft.
  const active = await deps.db
    .select({ productId: schema.enrichmentProposals.productId })
    .from(schema.enrichmentProposals)
    .where(
      and(
        eq(schema.enrichmentProposals.tenantId, tenantId),
        inArray(schema.enrichmentProposals.productId, ownedIds),
        inArray(schema.enrichmentProposals.status, ["pending", "generating", "ready"]),
        isNull(schema.enrichmentProposals.reviewedAt)
      )
    );
  const staged = new Set(active.map((a) => a.productId));
  const ownedSet = new Set(ownedIds);

  const drafts: { proposalId: string; productId: string }[] = [];
  for (const productId of productIds) {
    if (!ownedSet.has(productId) || staged.has(productId)) continue;
    const proposalId = randomUUID();
    await deps.db.insert(schema.enrichmentProposals).values({
      proposalId,
      tenantId,
      merchantId,
      productId,
      status: "pending",
    });
    drafts.push({ proposalId, productId });
  }
  return c.json({ data: { drafts } }, 201);
}

/** POST /catalog/enrichment/:proposalId/run — enqueue the LLM job for a staged draft. */
export async function runEnrichment(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const { tenantId, merchantId } = ids(c);
  const proposalId = c.req.param("proposalId") as string;
  const requestId = (c.get("requestId" as never) as string) ?? randomUUID();
  const enrichQueue = deps.queues?.[QUEUE.PRODUCT_ENRICH];
  if (!enrichQueue) {
    return c.json({ error: { code: "UNAVAILABLE", message: "Enrichment is not configured" } }, 503);
  }

  const rows = await deps.db
    .select()
    .from(schema.enrichmentProposals)
    .where(
      and(
        eq(schema.enrichmentProposals.proposalId, proposalId),
        eq(schema.enrichmentProposals.tenantId, tenantId)
      )
    )
    .limit(1);
  const prop = rows[0];
  if (!prop || prop.merchantId !== merchantId) {
    return c.json({ error: { code: "NOT_FOUND", message: "Draft not found" } }, 404);
  }
  if (prop.status === "generating" || prop.status === "ready") {
    return c.json({ data: { proposalId, status: prop.status } });
  }
  if (prop.status !== "pending" && prop.status !== "failed") {
    return c.json({ error: { code: "INVALID_STATE", message: `Draft is '${prop.status}'` } }, 409);
  }

  const jobId = `enrich-${tenantId}-${prop.productId}-${proposalId}`;
  await deps.db
    .update(schema.enrichmentProposals)
    .set({ status: "generating", updatedAt: new Date() })
    .where(eq(schema.enrichmentProposals.proposalId, proposalId));
  await enrichQueue.add(
    JOB_KIND.PRODUCT_ENRICH,
    { tenantId, merchantId, productId: prop.productId, proposalId, requestId },
    { jobId, removeOnComplete: 1000, removeOnFail: 5000 }
  );
  return c.json({ data: { proposalId, status: "generating" } }, 202);
}

interface StoredField { attributeCode: string; decision?: string; editedValue?: unknown; [k: string]: unknown }
interface StoredCandidate { key: string; decision?: string; [k: string]: unknown }

/** POST /catalog/products/:id/enrich/:proposalId/review — save per-field decisions
 *  and move the draft to Review Commit (reviewed_at stamped). */
export async function reviewProposal(c: Context, deps: CatalogRouteDeps): Promise<Response> {
  const { tenantId, merchantId } = ids(c);
  const productId = c.req.param("id") as string;
  const proposalId = c.req.param("proposalId") as string;

  let body: { fieldDecisions?: unknown; candidateDecisions?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const fieldDecisions = Array.isArray(body.fieldDecisions)
    ? (body.fieldDecisions as { code: string; decision: string; editedValue?: unknown }[])
    : [];
  const candidateDecisions = Array.isArray(body.candidateDecisions)
    ? (body.candidateDecisions as { key: string; decision: string }[])
    : [];

  const rows = await deps.db
    .select()
    .from(schema.enrichmentProposals)
    .where(
      and(
        eq(schema.enrichmentProposals.proposalId, proposalId),
        eq(schema.enrichmentProposals.tenantId, tenantId)
      )
    )
    .limit(1);
  const prop = rows[0];
  if (!prop || prop.merchantId !== merchantId || prop.productId !== productId) {
    return c.json({ error: { code: "NOT_FOUND", message: "Draft not found" } }, 404);
  }
  if (prop.status !== "ready") {
    return c.json({ error: { code: "INVALID_STATE", message: `Draft is '${prop.status}'` } }, 409);
  }

  const fieldDec = new Map(fieldDecisions.map((d) => [d.code, d]));
  const candDec = new Map(candidateDecisions.map((d) => [d.key, d]));
  const fields = ((prop.fields ?? []) as StoredField[]).map((f) => {
    const d = fieldDec.get(f.attributeCode);
    if (!d) return f;
    const next: StoredField = { ...f, decision: d.decision };
    if (d.decision === "edit" && d.editedValue !== undefined) next.editedValue = d.editedValue;
    return next;
  });
  const candidates = ((prop.candidates ?? []) as StoredCandidate[]).map((cand) => {
    const d = candDec.get(cand.key);
    return d ? { ...cand, decision: d.decision } : cand;
  });

  await deps.db
    .update(schema.enrichmentProposals)
    .set({ fields, candidates, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.enrichmentProposals.proposalId, proposalId));

  return c.json({ data: { ok: true } });
}
