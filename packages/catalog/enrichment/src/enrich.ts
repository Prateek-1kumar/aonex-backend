// Catalog enrichment — orchestrator.
//
// generateEnrichmentProposal: classify + resolve the dynamic schema -> build the
// two-pass prompt -> call the model -> parse + validate -> build the reviewable
// proposal. DB-free: the worker loads the ProductSnapshot and persists the result.

import type { IModelProvider } from "@aonex/ingestion-llm-extractor";
import {
  resolveActiveSchema,
  type ClassifySignals,
  type ResolveOptions,
} from "@aonex/archetypes";
import { buildEnrichmentPrompt, ENRICH_PROMPT_VERSION } from "./prompt.js";
import { parseEnrichmentResponse } from "./parse.js";
import { buildProposal } from "./proposal.js";
import type { EnrichmentProposal, ProductSnapshot } from "./types.js";

export interface EnrichDeps {
  provider: IModelProvider;
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** Request strict JSON (response_format) — on by default; OpenAI/Groq support it. */
  jsonMode?: boolean;
  /** DB-hydrated, self-extended archetype specs override (Phase 1+). */
  resolveOptions?: ResolveOptions;
}

export async function generateEnrichmentProposal(
  snapshot: ProductSnapshot,
  deps: EnrichDeps
): Promise<EnrichmentProposal> {
  const signals: ClassifySignals = {};
  if (snapshot.title != null) signals.title = snapshot.title;
  if (snapshot.categoryPath != null) signals.categoryPath = snapshot.categoryPath;
  if (snapshot.brand != null) signals.brand = snapshot.brand;

  const schema = resolveActiveSchema(signals, deps.resolveOptions ?? {});
  const messages = buildEnrichmentPrompt(snapshot, schema);

  const result = await deps.provider.chatCompletion({
    model: deps.model,
    messages,
    maxTokens: deps.maxTokens ?? 8000,
    temperature: deps.temperature ?? 0.4,
    jsonMode: deps.jsonMode ?? true,
  });

  const parsed = parseEnrichmentResponse(result.content);
  const costUsd = deps.provider.estimateCost(result.model, result.usage);

  return buildProposal({
    snapshot,
    schema,
    parsed,
    model: result.model,
    promptVersion: ENRICH_PROMPT_VERSION,
    ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    usage: { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens },
    costUsd,
  });
}
