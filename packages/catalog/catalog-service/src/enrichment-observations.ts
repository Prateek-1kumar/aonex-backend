// Append LLM-enrichment observations to catalog_products.values — the single
// write-path shared by the worker (auto-applied grounded fields) and the API
// apply flow (human-confirmed proposals). Observations land under source
// "enrichment:llm" at the `_unscoped`/`_unscoped` leaf (the channel/locale the
// list + detail projections prefer); a global priority-0 source_priority rule
// ("enrichment:*") makes them curator-grade. The caller is responsible for
// running projectSync over the affected attributes afterwards.

import { eq } from "drizzle-orm";
import { schema, type DrizzleExecutor } from "@aonex/db";
import { PROTECTED_KEYS } from "@aonex/types";

export const ENRICHMENT_SOURCE = "enrichment:llm";

export interface EnrichmentObservation {
  /** Canonical attribute code. */
  code: string;
  value: unknown;
  confidence: number;
  reasoning?: string;
}

export interface AppendEnrichmentObservationsArgs {
  productId: string;
  /** Links observations back to the enrichment_proposals row (used by revert). */
  proposalId: string;
  observations: EnrichmentObservation[];
  model?: string | null;
  promptVersion?: string | null;
  /** Reviewer identity when human-approved; omitted for worker auto-apply. */
  actor?: string;
  /** True when the worker wrote the observation without human review. */
  autoApplied?: boolean;
  now: Date;
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

/**
 * Append the observations inside the caller's executor (transaction or plain
 * client) and return the attribute codes actually written. Protected commerce
 * facts are silently skipped — defense in depth on top of engine omission.
 */
export async function appendEnrichmentObservations(
  executor: DrizzleExecutor,
  args: AppendEnrichmentObservationsArgs
): Promise<string[]> {
  const writable = args.observations.filter((o) => !PROTECTED_KEYS.has(o.code));
  if (writable.length === 0) return [];

  const rows = await executor
    .select({ values: schema.catalogProducts.values })
    .from(schema.catalogProducts)
    .where(eq(schema.catalogProducts.productId, args.productId))
    .limit(1);
  const values = (rows[0]?.values ?? {}) as ValuesJson;

  for (const o of writable) {
    if (!values[o.code]) values[o.code] = {};
    const attr = values[o.code]!;
    if (!attr["_unscoped"]) attr["_unscoped"] = {};
    const chan = attr["_unscoped"]!;
    if (!chan["_unscoped"]) chan["_unscoped"] = [];
    const extras: Record<string, unknown> = {
      model: args.model ?? null,
      prompt_version: args.promptVersion ?? null,
    };
    if (o.reasoning) extras.reasoning = o.reasoning;
    if (args.actor) extras.approved_by = args.actor;
    if (args.autoApplied) extras.auto_applied = true;
    chan["_unscoped"]!.push({
      source: ENRICHMENT_SOURCE,
      source_record_id: args.proposalId,
      value: o.value,
      confidence: o.confidence,
      observed_at: args.now.toISOString(),
      extras,
    });
  }

  await executor
    .update(schema.catalogProducts)
    .set({ values, updatedAt: args.now })
    .where(eq(schema.catalogProducts.productId, args.productId));

  return [...new Set(writable.map((o) => o.code))];
}
