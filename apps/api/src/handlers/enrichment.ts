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
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@aonex/db";
import { MerchantId, TenantId, QUEUE, JOB_KIND } from "@aonex/types";
import type { CatalogRouteDeps } from "../routes/catalog.js";
import {
  applyEnrichmentProposal,
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
