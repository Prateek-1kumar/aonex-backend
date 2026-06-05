// Apply an enrichment proposal (review-then-apply, spec D1/§2.4).
//
// Accepted fields + accepted candidate values become observations under source
// "enrichment:llm" at the `_unscoped`/`_unscoped` leaf (the channel/locale the
// list + detail projections prefer). A global priority-0 source_priority
// rule ("enrichment:*") makes these curator-grade — they win over automated
// sources and persist across re-ingests. Accepted candidates are ALSO registered
// into attribute_definitions + archetype_attribute_specs (the self-extension
// loop). projectSync then recomputes winning_values + the completeness score.
//
// Protected commerce facts (price/currency/inventory/identifiers) are never
// written — guarded here as defense in depth on top of the engine omitting them.

import { and, eq } from "drizzle-orm";
import type { DrizzleClient } from "@aonex/db";
import { schema } from "@aonex/db";
import { PROTECTED_KEYS } from "@aonex/archetypes";
import { projectSync } from "@aonex/catalog-service";

export class EnrichmentApplyError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: string
  ) {
    super(message);
    this.name = "EnrichmentApplyError";
  }
}

interface ProposalFieldRow {
  attributeCode: string;
  after: unknown;
  confidence: number;
  reasoning?: string;
  valid: boolean;
}
interface CandidateRow {
  key: string;
  label: string;
  group?: string;
  dataType: "string" | "number" | "boolean" | "array" | "object";
  value: unknown;
  enumCandidates?: string[];
}

export interface FieldDecision {
  code: string;
  decision: "accept" | "reject" | "edit";
  editedValue?: unknown;
}
export interface CandidateDecisionInput {
  key: string;
  decision: "accept" | "reject";
}

export interface ApplyEnrichmentInput {
  tenantId: string;
  merchantId: string;
  productId: string;
  proposalId: string;
  fieldDecisions: FieldDecision[];
  candidateDecisions: CandidateDecisionInput[];
  actor?: string;
}

export interface ApplyEnrichmentResult {
  productId: string;
  applied: string[];
  registered: string[];
  score: number;
  contentScore?: number;
}

interface StoredObservation {
  source: string;
  source_record_id: string;
  value: unknown;
  confidence: number;
  observed_at: string;
  extras?: Record<string, unknown>;
}
type ValuesJson = Record<string, Record<string, Record<string, StoredObservation[]>>>;

const ENRICHMENT_SOURCE = "enrichment:llm";

export async function applyEnrichmentProposal(
  db: DrizzleClient,
  input: ApplyEnrichmentInput
): Promise<ApplyEnrichmentResult> {
  const propRows = await db
    .select()
    .from(schema.enrichmentProposals)
    .where(
      and(
        eq(schema.enrichmentProposals.proposalId, input.proposalId),
        eq(schema.enrichmentProposals.tenantId, input.tenantId)
      )
    )
    .limit(1);
  const prop = propRows[0];
  if (!prop || prop.merchantId !== input.merchantId || prop.productId !== input.productId) {
    throw new EnrichmentApplyError("Proposal not found", 404, "NOT_FOUND");
  }
  if (prop.status !== "ready") {
    throw new EnrichmentApplyError(
      `Proposal is '${prop.status}', expected 'ready'`,
      409,
      "INVALID_STATE"
    );
  }

  const fields = (prop.fields ?? []) as ProposalFieldRow[];
  const candidates = (prop.candidates ?? []) as CandidateRow[];
  const fieldDec = new Map(input.fieldDecisions.map((d) => [d.code, d]));
  const candDec = new Map(input.candidateDecisions.map((d) => [d.key, d]));

  // Resolve accepted field values.
  const accepted: { code: string; value: unknown; confidence: number; reasoning?: string }[] = [];
  for (const f of fields) {
    if (PROTECTED_KEYS.has(f.attributeCode)) continue;
    const d = fieldDec.get(f.attributeCode);
    if (!d) continue;
    if (d.decision === "accept") {
      accepted.push({
        code: f.attributeCode,
        value: f.after,
        confidence: f.confidence,
        ...(f.reasoning ? { reasoning: f.reasoning } : {}),
      });
    } else if (d.decision === "edit") {
      accepted.push({
        code: f.attributeCode,
        value: d.editedValue,
        confidence: f.confidence,
        ...(f.reasoning ? { reasoning: f.reasoning } : {}),
      });
    }
  }

  const acceptedCandidates = candidates.filter(
    (c) => !PROTECTED_KEYS.has(c.key) && candDec.get(c.key)?.decision === "accept"
  );

  const now = new Date();
  const registered: string[] = [];

  await db.transaction(async (tx) => {
    // Register accepted candidates (self-extension) + queue their values to write.
    for (const c of acceptedCandidates) {
      await tx
        .insert(schema.attributeDefinitions)
        .values({
          canonicalKey: c.key,
          dataType: c.dataType,
          enumValues: c.enumCandidates ?? [],
          label: c.label,
          enrichmentGroup: c.group ?? "descriptive",
          appliesUniversally: false,
          origin: "llm_proposed",
          status: "active",
          proposedFromProductId: input.productId,
        })
        .onConflictDoNothing();
      await tx
        .insert(schema.archetypeAttributeSpecs)
        .values({
          archetypeId: prop.archetype ?? "generic",
          canonicalKey: c.key,
          tier: "recommended",
          weight: "0.400",
          origin: "llm_proposed",
        })
        .onConflictDoNothing();
      registered.push(c.key);
      accepted.push({ code: c.key, value: c.value, confidence: 0.6 });
    }

    // Append observations to catalog_products.values at the _primary leaf.
    const rows = await tx
      .select({ values: schema.catalogProducts.values })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, input.productId))
      .limit(1);
    const values = (rows[0]?.values ?? {}) as ValuesJson;

    for (const a of accepted) {
      if (PROTECTED_KEYS.has(a.code)) continue;
      if (!values[a.code]) values[a.code] = {};
      const attr = values[a.code]!;
      if (!attr["_unscoped"]) attr["_unscoped"] = {};
      const chan = attr["_unscoped"]!;
      if (!chan["_unscoped"]) chan["_unscoped"] = [];
      const extras: Record<string, unknown> = {
        model: prop.model,
        prompt_version: prop.promptVersion,
      };
      if (a.reasoning) extras.reasoning = a.reasoning;
      if (input.actor) extras.approved_by = input.actor;
      chan["_unscoped"]!.push({
        source: ENRICHMENT_SOURCE,
        source_record_id: prop.proposalId,
        value: a.value,
        confidence: a.confidence,
        observed_at: now.toISOString(),
        extras,
      });
    }

    await tx
      .update(schema.catalogProducts)
      .set({ values, updatedAt: now })
      .where(eq(schema.catalogProducts.productId, input.productId));

    await tx
      .update(schema.enrichmentProposals)
      .set({ status: "applied", resolvedAt: now, updatedAt: now })
      .where(eq(schema.enrichmentProposals.proposalId, input.proposalId));
  });

  // Reconcile the touched attributes — recomputes winning_values + the score.
  const affected = [...new Set(accepted.map((a) => a.code))].filter((c) => !PROTECTED_KEYS.has(c));
  if (affected.length > 0) {
    await projectSync({ db, productId: input.productId, affectedAttributes: affected, rulesVersion: 1 });
  }

  // Persist the LLM content-quality score (folded into the proposal's scoreAfter).
  const scoreAfter = (prop.scoreAfter ?? {}) as { contentQuality?: number };
  const contentScore = typeof scoreAfter.contentQuality === "number" ? scoreAfter.contentQuality : null;
  if (contentScore != null) {
    await db
      .update(schema.catalogProducts)
      .set({ contentQualityScore: contentScore.toFixed(2) })
      .where(eq(schema.catalogProducts.productId, input.productId));
  }

  const after = await db
    .select({ score: schema.catalogProducts.completenessScore })
    .from(schema.catalogProducts)
    .where(eq(schema.catalogProducts.productId, input.productId))
    .limit(1);

  return {
    productId: input.productId,
    applied: accepted.map((a) => a.code),
    registered,
    score: Number(after[0]?.score ?? 0),
    ...(contentScore != null ? { contentScore } : {}),
  };
}

export interface RevertEnrichmentInput {
  tenantId: string;
  merchantId: string;
  productId: string;
  proposalId: string;
}

/** Undo an applied enrichment: strip its enrichment:llm observations, reconcile,
 *  and clear the content-quality score. The catalog falls back to source values. */
export async function revertEnrichmentProposal(
  db: DrizzleClient,
  input: RevertEnrichmentInput
): Promise<{ productId: string; score: number }> {
  const propRows = await db
    .select()
    .from(schema.enrichmentProposals)
    .where(
      and(
        eq(schema.enrichmentProposals.proposalId, input.proposalId),
        eq(schema.enrichmentProposals.tenantId, input.tenantId)
      )
    )
    .limit(1);
  const prop = propRows[0];
  if (!prop || prop.merchantId !== input.merchantId || prop.productId !== input.productId) {
    throw new EnrichmentApplyError("Proposal not found", 404, "NOT_FOUND");
  }
  if (prop.status !== "applied") {
    throw new EnrichmentApplyError(`Proposal is '${prop.status}', not applied`, 409, "INVALID_STATE");
  }

  const affected: string[] = [];
  const now = new Date();
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ values: schema.catalogProducts.values })
      .from(schema.catalogProducts)
      .where(eq(schema.catalogProducts.productId, input.productId))
      .limit(1);
    const values = (rows[0]?.values ?? {}) as ValuesJson;

    for (const [attr, byChannel] of Object.entries(values)) {
      for (const byLocale of Object.values(byChannel)) {
        for (const [loc, obs] of Object.entries(byLocale)) {
          if (!Array.isArray(obs)) continue;
          const kept = obs.filter(
            (o) => !(o.source === ENRICHMENT_SOURCE && o.source_record_id === prop.proposalId)
          );
          if (kept.length !== obs.length) {
            byLocale[loc] = kept;
            if (!affected.includes(attr)) affected.push(attr);
          }
        }
      }
    }

    await tx
      .update(schema.catalogProducts)
      .set({ values, contentQualityScore: null, updatedAt: now })
      .where(eq(schema.catalogProducts.productId, input.productId));
    await tx
      .update(schema.enrichmentProposals)
      .set({ status: "rejected", updatedAt: now })
      .where(eq(schema.enrichmentProposals.proposalId, input.proposalId));
  });

  if (affected.length > 0) {
    await projectSync({ db, productId: input.productId, affectedAttributes: affected, rulesVersion: 1 });
  }

  const after = await db
    .select({ score: schema.catalogProducts.completenessScore })
    .from(schema.catalogProducts)
    .where(eq(schema.catalogProducts.productId, input.productId))
    .limit(1);
  return { productId: input.productId, score: Number(after[0]?.score ?? 0) };
}
