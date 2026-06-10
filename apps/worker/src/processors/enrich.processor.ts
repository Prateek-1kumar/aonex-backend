// catalog.product_enrich queue processor — runs the grounded node-schema
// enrichment engine (@aonex/taxonomy-enrichment) for a single product.
//
// Flow (generating -> ready | failed):
//   load product -> resolve its taxonomy leaf schema (node_attributes) ->
//   build catalog-RAG few-shot examples -> enrichProduct ->
//   AUTO-APPLY the `accepted` fields (valid + source-grounded + above
//   threshold) as enrichment:llm observations + projectSync ->
//   persist the full result to the enrichment_proposals row, where the
//   `proposable` (inferred) remainder awaits Lab review-then-apply.
//
// An ungrounded fact is never written without review — that invariant lives
// in the engine's calibration (acceptInferred:false), not here.

import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleClient } from "@aonex/db";
import { schema } from "@aonex/db";
import type { IModelProvider } from "@aonex/ingestion-llm-extractor";
import {
  enrichProduct,
  retrieveExamples,
  ENRICH_PROMPT_VERSION,
  type EnrichmentResult,
} from "@aonex/taxonomy-enrichment";
import {
  loadLeafSchemas,
  loadRagCorpusEntries,
  flattenWinningAttrs,
  firstScoped,
  asText,
  type CorpusEntryWithId,
  type LeafSchemaIndex,
} from "@aonex/taxonomy-schema";
import { appendEnrichmentObservations, projectSync } from "@aonex/catalog-service";
import { QUEUE, PROTECTED_KEYS, type PersistedProposalField } from "@aonex/types";

export type { PersistedProposalField };

export interface ProductEnrichJobData {
  tenantId: string;
  merchantId: string;
  productId: string;
  proposalId: string;
  requestId?: string;
}

export interface EnrichProcessorDeps {
  db: DrizzleClient;
  provider: IModelProvider;
  model: string;
}

/** The per-job read-mostly context: the leaf-schema index + the RAG corpus.
 *  Both are full-table loads of effectively static data, so the processor
 *  caches them across jobs (a bulk enrich of 50 products must not run 50
 *  full-catalog scans). Injectable so tests can supply a fixture context. */
export interface EnrichContext {
  index: LeafSchemaIndex;
  corpusEntries: CorpusEntryWithId[];
}

export type EnrichContextLoader = () => Promise<EnrichContext>;

export function makeEnrichContextLoader(db: DrizzleClient, ttlMs = 60_000): EnrichContextLoader {
  let cached: { ctx: EnrichContext; at: number } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.ctx;
    const [index, corpusEntries] = await Promise.all([loadLeafSchemas(db), loadRagCorpusEntries(db)]);
    cached = { ctx: { index, corpusEntries }, at: Date.now() };
    return cached.ctx;
  };
}

/** Project the engine result onto the persisted proposal-field rows
 *  (PersistedProposalField, the shared contract in @aonex/types): only fields
 *  the model actually proposed, with the UI/apply-compatible shape. */
export function toProposalFields(
  result: EnrichmentResult,
  knownAttrs: Record<string, unknown>,
  groupByKey: Map<string, string>
): PersistedProposalField[] {
  const out: PersistedProposalField[] = [];
  for (const f of result.fields) {
    if (f.status === "missing") continue; // nothing proposed for this field
    if (PROTECTED_KEYS.has(f.key)) continue; // defense in depth
    const group = groupByKey.get(f.key);
    out.push({
      attributeCode: f.key,
      ...(group !== undefined ? { group } : {}),
      before: knownAttrs[f.key] ?? null,
      after: f.normalized ?? f.raw,
      confidence: f.calibratedConfidence,
      ...(f.reasoning ? { reasoning: f.reasoning } : {}),
      action: f.action,
      valid: f.status === "ok" || f.status === "coerced",
      ...(f.status === "invalid" && f.message ? { validationError: f.message } : {}),
      grounding: f.grounding,
      support: f.support,
      ...(f.evidence ? { evidence: f.evidence } : {}),
      accepted: f.accepted,
      proposable: f.proposable,
    });
  }
  return out;
}

export async function runEnrich(
  deps: EnrichProcessorDeps,
  data: ProductEnrichJobData,
  loadContext: EnrichContextLoader = makeEnrichContextLoader(deps.db, 0)
): Promise<void> {
  const { db } = deps;
  await db
    .update(schema.enrichmentProposals)
    .set({ status: "generating", updatedAt: new Date() })
    .where(eq(schema.enrichmentProposals.proposalId, data.proposalId));

  try {
    const rows = await db
      .select({
        productId: schema.catalogProducts.productId,
        identity: schema.catalogProducts.identity,
        winningValues: schema.catalogProducts.winningValues,
        categoryNodeId: schema.catalogProducts.categoryNodeId,
        genTitle: sql<string | null>`gen_title`,
        genBrand: sql<string | null>`gen_brand`,
      })
      .from(schema.catalogProducts)
      .where(
        and(
          eq(schema.catalogProducts.productId, data.productId),
          eq(schema.catalogProducts.tenantId, data.tenantId)
        )
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw new Error(`enrich: product ${data.productId} not found`);

    const nodeId = row.categoryNodeId;
    if (!nodeId) {
      throw new Error(
        "enrich: product has no taxonomy category (category_node_id) — classify it before enrichment"
      );
    }

    const { index, corpusEntries } = await loadContext();
    const fields = index.schemaByNode.get(nodeId);
    if (!fields || fields.length === 0) {
      throw new Error(`enrich: taxonomy node "${nodeId}" has no attribute schema (node_attributes)`);
    }

    const wv = (row.winningValues ?? {}) as Record<string, unknown>;
    const identity = (row.identity ?? {}) as Record<string, unknown>;
    const knownAttrs = flattenWinningAttrs(wv);
    const title = row.genTitle ?? asText(firstScoped(wv.title));
    const brand =
      row.genBrand ?? (typeof identity.brand === "string" ? identity.brand : undefined);
    const description = asText(firstScoped(wv.description_long));
    const sourceCategory = asText(firstScoped(wv.category_path));

    const corpus = corpusEntries
      .filter((e) => e.productId !== data.productId)
      .map((e) => e.entry);
    const examples = retrieveExamples(
      { ...(title ? { title } : {}), ...(brand ? { brand } : {}), nodeId },
      corpus,
      { k: 3 }
    );

    const result = await enrichProduct(
      {
        nodeId,
        nodePath: index.pathByNode.get(nodeId) ?? nodeId,
        schema: fields,
        product: {
          ...(title ? { title } : {}),
          ...(brand ? { brand } : {}),
          ...(description ? { description } : {}),
          ...(sourceCategory ? { sourceCategory } : {}),
          knownAttrs,
        },
        examples,
      },
      { provider: deps.provider, model: deps.model }
    );

    if (result.error) {
      throw new Error(`enrich: model call failed — ${result.error}`);
    }

    const now = new Date();

    // Auto-apply the accepted (valid + grounded + above threshold) fields.
    const accepted = result.fields
      .filter((f) => f.accepted && f.normalized !== undefined)
      .map((f) => ({
        code: f.key,
        value: f.normalized,
        confidence: f.calibratedConfidence,
        ...(f.reasoning ? { reasoning: f.reasoning } : {}),
      }));
    const applied = await appendEnrichmentObservations(db, {
      productId: data.productId,
      proposalId: data.proposalId,
      observations: accepted,
      model: result.model ?? deps.model,
      promptVersion: ENRICH_PROMPT_VERSION,
      autoApplied: true,
      now,
    });
    if (applied.length > 0) {
      await projectSync({ db, productId: data.productId, affectedAttributes: applied, rulesVersion: 1 });
    }

    await db
      .update(schema.enrichmentProposals)
      .set({
        status: "ready",
        // Column predates the taxonomy spine: it now carries the taxonomy
        // node id (the schema source), not an archetype id.
        archetype: nodeId,
        model: result.model ?? deps.model,
        promptVersion: ENRICH_PROMPT_VERSION,
        fields: toProposalFields(result, knownAttrs, index.groupByKey),
        candidates: result.candidates,
        scoreBefore: { completeness: result.completenessBefore.score },
        scoreAfter: {
          completeness: result.completenessProposed.score,
          autoApplied: result.completenessAfter.score,
          groundingRate: result.groundingRate,
        },
        reasoning: null,
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd.toFixed(5) } : {}),
        updatedAt: now,
      })
      .where(eq(schema.enrichmentProposals.proposalId, data.proposalId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[enrich] proposal ${data.proposalId} failed:`, message);
    await db
      .update(schema.enrichmentProposals)
      .set({ status: "failed", reasoning: `error: ${message}`, updatedAt: new Date() })
      .where(eq(schema.enrichmentProposals.proposalId, data.proposalId));
    throw err;
  }
}

export function makeEnrichProcessor(deps: EnrichProcessorDeps) {
  const loadContext = makeEnrichContextLoader(deps.db);
  return async (job: Job<ProductEnrichJobData>): Promise<void> => {
    await runEnrich(deps, job.data, loadContext);
  };
}

export const PROCESSOR_QUEUE = QUEUE.PRODUCT_ENRICH;
