// Grounded enrichment orchestrator.
//
//   prompt (schema + catalog-RAG) -> model -> parse -> NORMALIZE (validator)
//   -> VERIFY grounding (deterministic) -> CALIBRATE confidence -> result
//
// DB- and network-free except for the injected ChatProvider. The caller loads
// the leaf schema + RAG corpus and persists accepted fields as observations.

import { validateAttributes, type AttributeSpec, type FieldOutcome, type LeafSchema } from "@aonex/taxonomy-validator";
import { calibrate, DEFAULT_CALIBRATION, type CalibrationConfig } from "./calibrate.js";
import { parseEnrichmentResponse } from "./parse.js";
import { buildEnrichmentPrompt, ENRICH_PROMPT_VERSION } from "./prompt.js";
import { buildVerifyContext, verifyField } from "./verify.js";
import type {
  ChatProvider,
  EnrichField,
  EnrichmentInput,
  EnrichmentResult,
  FieldGeneration,
  FieldResult,
} from "./types.js";

export { ENRICH_PROMPT_VERSION };

export interface EnrichDeps {
  provider: ChatProvider;
  model: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  calibration?: CalibrationConfig;
}

/** EnrichField[] -> the validator's LeafSchema (drops prompt-only metadata). */
export function toLeafSchema(nodeId: string, fields: EnrichField[]): LeafSchema {
  const attributes: AttributeSpec[] = fields.map((f) => ({
    key: f.key,
    tier: f.tier,
    ...(f.dataType ? { dataType: f.dataType } : {}),
    ...(f.enumValues?.length ? { enumValues: f.enumValues } : {}),
    ...(f.unit ? { unit: f.unit } : {}),
    ...(f.allowedUnits?.length ? { allowedUnits: f.allowedUnits } : {}),
    ...(f.min !== undefined ? { min: f.min } : {}),
    ...(f.max !== undefined ? { max: f.max } : {}),
  }));
  return { nodeId, attributes };
}

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Map of accepted, normalized attribute values — what the caller would persist. */
export function acceptedAttributes(result: EnrichmentResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of result.fields) if (f.accepted && f.normalized !== undefined) out[f.key] = f.normalized;
  return out;
}

function buildField(
  spec: EnrichField,
  gen: FieldGeneration | undefined,
  outcome: FieldOutcome,
  known: Record<string, unknown>,
  ctx: ReturnType<typeof buildVerifyContext>,
  cfg: CalibrationConfig
): FieldResult {
  const action = isEmpty(known[spec.key]) ? "fill" : "improve";

  if (!gen || isEmpty(gen.value)) {
    return {
      key: spec.key,
      tier: spec.tier,
      raw: gen?.value ?? null,
      status: "missing",
      grounding: "inferred",
      support: 0,
      modelConfidence: gen?.confidence ?? 0,
      calibratedConfidence: 0,
      accepted: false,
      proposable: false,
      action,
    };
  }

  const verdict = verifyField(gen, ctx);
  const { calibratedConfidence, accepted, proposable } = calibrate(
    { modelConfidence: gen.confidence, support: verdict.support, grounding: verdict.grounding, status: outcome.status },
    cfg
  );

  return {
    key: spec.key,
    tier: spec.tier,
    raw: gen.value,
    ...(outcome.normalized !== undefined ? { normalized: outcome.normalized } : {}),
    status: outcome.status,
    grounding: verdict.grounding,
    support: verdict.support,
    modelConfidence: gen.confidence,
    calibratedConfidence,
    accepted,
    proposable,
    action,
    ...(gen.evidence ? { evidence: gen.evidence } : {}),
    ...(gen.reasoning ? { reasoning: gen.reasoning } : {}),
    ...(outcome.message ? { message: outcome.message } : verdict.detail ? { message: verdict.detail } : {}),
  };
}

export async function enrichProduct(input: EnrichmentInput, deps: EnrichDeps): Promise<EnrichmentResult> {
  const leaf = toLeafSchema(input.nodeId, input.schema);
  const known = input.product.knownAttrs ?? {};
  const completenessBefore = validateAttributes(leaf, known).completeness;

  const messages = buildEnrichmentPrompt(input);

  let parsed;
  let model = deps.model;
  let usage: { promptTokens: number; completionTokens: number } | undefined;
  let costUsd: number | undefined;
  try {
    const res = await deps.provider.chatCompletion({
      model: deps.model,
      messages,
      maxTokens: deps.maxTokens ?? 4000,
      temperature: deps.temperature ?? 0.2,
      jsonMode: deps.jsonMode ?? true,
    });
    parsed = parseEnrichmentResponse(res.content);
    if (res.model) model = res.model;
    if (res.usage) usage = res.usage;
    if (deps.provider.estimateCost && res.usage) {
      costUsd = deps.provider.estimateCost(model, { ...res.usage, totalTokens: res.usage.promptTokens + res.usage.completionTokens });
    }
  } catch (err) {
    return {
      nodeId: input.nodeId,
      fields: input.schema.map((spec) => buildField(spec, undefined, { key: spec.key, tier: spec.tier, status: "missing" }, known, buildVerifyContext(input.product), deps.calibration ?? DEFAULT_CALIBRATION)),
      candidates: [],
      completenessBefore,
      completenessAfter: completenessBefore,
      completenessProposed: completenessBefore,
      groundingRate: 0,
      proposedInferred: 0,
      model,
      error: (err as Error).message,
    };
  }

  const cfg = deps.calibration ?? DEFAULT_CALIBRATION;
  const ctx = buildVerifyContext(input.product);
  const genByKey = new Map(parsed.fields.map((f) => [f.key, f]));

  // Normalize ALL generated values for schema fields in one pass.
  const genMap: Record<string, unknown> = {};
  for (const spec of input.schema) {
    const g = genByKey.get(spec.key);
    if (g && !isEmpty(g.value)) genMap[spec.key] = g.value;
  }
  const outcomeByKey = new Map(validateAttributes(leaf, genMap).fields.map((o) => [o.key, o]));

  const fields = input.schema.map((spec) =>
    buildField(spec, genByKey.get(spec.key), outcomeByKey.get(spec.key) ?? { key: spec.key, tier: spec.tier, status: "missing" }, known, ctx, cfg)
  );

  const acceptedMap: Record<string, unknown> = {};
  const proposableMap: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.normalized === undefined) continue;
    if (f.accepted) acceptedMap[f.key] = f.normalized;
    if (f.proposable) proposableMap[f.key] = f.normalized;
  }
  const completenessAfter = validateAttributes(leaf, acceptedMap).completeness;
  const completenessProposed = validateAttributes(leaf, proposableMap).completeness;

  const acceptedFields = fields.filter((f) => f.accepted);
  const grounded = acceptedFields.filter((f) => f.grounding === "grounded" || f.grounding === "weak").length;
  const groundingRate = acceptedFields.length === 0 ? 0 : grounded / acceptedFields.length;
  const proposedInferred = fields.filter((f) => f.proposable && !f.accepted && f.grounding === "inferred").length;

  return {
    nodeId: input.nodeId,
    fields,
    candidates: parsed.candidates,
    completenessBefore,
    completenessAfter,
    completenessProposed,
    groundingRate,
    proposedInferred,
    model,
    ...(usage ? { usage } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}
