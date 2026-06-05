// catalog.product_enrich queue processor — runs the LLM enrichment engine for a
// single product and writes the result into the pre-created enrichment_proposals
// row (generating -> ready | failed). The catalog is NOT touched here; that
// happens at apply (API), review-then-apply per spec D1.

import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleClient } from "@aonex/db";
import { schema } from "@aonex/db";
import type { IModelProvider } from "@aonex/ingestion-llm-extractor";
import { generateEnrichmentProposal, type ProductSnapshot } from "@aonex/catalog-enrichment";
import { QUEUE } from "@aonex/types";

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

/** Flatten the 4-axis winning_values into attributeCode -> display value,
 *  preferring the `_primary` channel then `_unscoped`/`en` locale. */
function flattenWinning(wv: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!wv) return out;
  for (const [attr, byChannel] of Object.entries(wv)) {
    if (attr === "_meta" || !byChannel || typeof byChannel !== "object") continue;
    const channels = byChannel as Record<string, unknown>;
    const chanVal = channels["_primary"] ?? Object.values(channels)[0];
    if (!chanVal || typeof chanVal !== "object") continue;
    const byLocale = chanVal as Record<string, unknown>;
    const leaf = byLocale["_unscoped"] ?? byLocale["en"] ?? Object.values(byLocale)[0];
    if (leaf !== undefined) out[attr] = leaf;
  }
  return out;
}

export async function runEnrich(
  deps: EnrichProcessorDeps,
  data: ProductEnrichJobData
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
        family: schema.catalogProducts.family,
        identity: schema.catalogProducts.identity,
        identifiers: schema.catalogProducts.identifiers,
        winningValues: schema.catalogProducts.winningValues,
        genPrice: sql<string | null>`gen_primary_price`,
        genCurrency: sql<string | null>`gen_primary_currency`,
        genGtin: sql<string | null>`gen_gtin`,
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

    const current = flattenWinning(row.winningValues as Record<string, unknown> | null);
    const identity = (row.identity ?? {}) as Record<string, unknown>;
    const identifiers = row.identifiers;
    const title =
      row.genTitle ?? (typeof current.title === "string" ? current.title : undefined);
    const brand =
      row.genBrand ??
      (typeof current.brand === "string"
        ? current.brand
        : typeof identity.brand === "string"
          ? identity.brand
          : undefined);
    const cp = current.category_path;
    const categoryPath = Array.isArray(cp)
      ? cp.join("/")
      : typeof cp === "string"
        ? cp
        : undefined;

    const snapshot: ProductSnapshot = {
      productId: row.productId,
      family: row.family ?? null,
      current,
      facts: {
        hasPrice: row.genPrice != null,
        hasCurrency: row.genCurrency != null,
        hasIdentifier:
          row.genGtin != null || (Array.isArray(identifiers) && identifiers.length > 0),
        hasTitle: row.genTitle != null || typeof current.title === "string",
      },
      ...(title ? { title } : {}),
      ...(brand ? { brand } : {}),
      ...(categoryPath ? { categoryPath } : {}),
    };

    const proposal = await generateEnrichmentProposal(snapshot, {
      provider: deps.provider,
      model: deps.model,
    });

    await db
      .update(schema.enrichmentProposals)
      .set({
        status: "ready",
        archetype: proposal.archetype,
        model: proposal.model,
        promptVersion: proposal.promptVersion,
        fields: proposal.fields,
        candidates: proposal.candidates,
        scoreBefore: proposal.scoreBefore,
        scoreAfter: proposal.scoreAfter,
        reasoning: proposal.reasoning ?? null,
        costUsd: proposal.costUsd.toFixed(5),
        updatedAt: new Date(),
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
  return async (job: Job<ProductEnrichJobData>): Promise<void> => {
    await runEnrich(deps, job.data);
  };
}

export const PROCESSOR_QUEUE = QUEUE.PRODUCT_ENRICH;
