// Grounded enrichment orchestrator — TWO STAGES.
//
//   Stage 1 (specs)   : schema-conditioned extraction of the leaf's typed
//                       attributes, verified by substring/token grounding.
//   Stage 2 (content) : SEO/marketing/AEO/description copy SYNTHESIZED from the
//                       facts confirmed in stage 1 (+ the known attrs), verified
//                       by compositional grounding (no fabricated figures).
//
// Content is composed from the catalog's own confirmed data + the taxonomy node —
// that is what makes enrichment productive (real listing content) instead of
// cosmetic, while staying "no random filling". Stage 2 never auto-applies: it
// flows to the drafting room for review.
//
// DB- and network-free except for the injected ChatProvider. The caller loads the
// leaf schema (specs + the universal content layer) + RAG corpus and persists.

import { validateAttributes, type AttributeSpec, type FieldOutcome, type LeafSchema } from "@aonex/taxonomy-validator";
import { calibrate, calibrateContent, CONTENT_PROPOSE_THRESHOLD, DEFAULT_CALIBRATION, type CalibrationConfig } from "./calibrate.js";
import { checkConsistency, type ConsistencyConflict, type ConsistencyDeps } from "./consistency.js";
import { parseEnrichmentResponse } from "./parse.js";
import { buildEnrichmentPrompt, ENRICH_PROMPT_VERSION } from "./prompt.js";
import { buildContentPrompt, CONTENT_PROMPT_VERSION } from "./content-prompt.js";
import { validateContentField } from "./content-validate.js";
import { scoreContent, scoreKnownContent } from "./content-score.js";
import { buildVerifyContext, verifyContentField, verifyField, type VerifyContext } from "./verify.js";
import type {
  ChatProvider,
  EnrichField,
  EnrichmentInput,
  EnrichmentResult,
  FieldGeneration,
  FieldResult,
} from "./types.js";

export { ENRICH_PROMPT_VERSION, CONTENT_PROMPT_VERSION };

export interface EnrichDeps {
  provider: ChatProvider;
  model: string;
  maxTokens?: number;
  /** Separate (larger) cap for the content stage's big JSON. Defaults to
   *  max(maxTokens, 8000) so content copy is never truncated. */
  contentMaxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  calibration?: CalibrationConfig;
  /** Optional cross-field consistency pass (Gap B). When provided, one extra LLM
   *  call audits the final field set for internal contradictions. Omit to skip
   *  (the default; keeps the engine + unit tests model-free for the second call). */
  consistency?: ConsistencyDeps;
}

/** EnrichField[] -> the validator's LeafSchema (drops prompt-only metadata).
 *  Content fields are synthesized copy, not typed specs — they never enter the
 *  taxonomy-validator (and so never pollute spec completeness). */
export function toLeafSchema(nodeId: string, fields: EnrichField[]): LeafSchema {
  const attributes: AttributeSpec[] = fields
    .filter((f) => f.kind !== "content")
    .map((f) => ({
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

/** The accepted / proposable normalized-value maps for the spec fields. Rebuilt
 *  after the consistency pass so completeness reflects any downgrades. */
function buildSpecMaps(specResults: FieldResult[]): {
  accepted: Record<string, unknown>;
  proposable: Record<string, unknown>;
} {
  const accepted: Record<string, unknown> = {};
  const proposable: Record<string, unknown> = {};
  for (const f of specResults) {
    if (f.normalized === undefined) continue;
    if (f.accepted) accepted[f.key] = f.normalized;
    if (f.proposable) proposable[f.key] = f.normalized;
  }
  return { accepted, proposable };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Run the consistency auditor over the final fields and apply its verdicts in
 *  place: a "hard" conflict marks the field contradicted (dropped); a "soft" one
 *  penalizes confidence and re-thresholds. Returns the flags for the result, or
 *  undefined when the pass found nothing / failed (best-effort). */
async function applyConsistency(
  fields: FieldResult[],
  deps: ConsistencyDeps,
  cfg: CalibrationConfig
): Promise<EnrichmentResult["consistencyFlags"]> {
  let conflicts: ConsistencyConflict[];
  try {
    conflicts = await checkConsistency(fields, deps);
  } catch {
    return undefined;
  }
  if (conflicts.length === 0) return undefined;

  const byKey = new Map(fields.map((f) => [f.key, f] as const));
  for (const c of conflicts) {
    for (const k of c.keys) {
      const f = byKey.get(k);
      if (!f) continue;
      f.consistencyNote = c.reason;
      if (c.severity === "hard") {
        f.grounding = "contradicted";
        f.accepted = false;
        f.proposable = false;
        f.calibratedConfidence = Math.min(f.calibratedConfidence, 0.1);
        f.message = `cross-field conflict: ${c.reason}`;
      } else {
        f.calibratedConfidence = round2(f.calibratedConfidence * 0.7);
        const bar = f.kind === "content" ? CONTENT_PROPOSE_THRESHOLD : cfg.acceptThreshold;
        f.proposable = f.calibratedConfidence >= bar;
        if (f.kind !== "content") f.accepted = f.accepted && f.proposable;
        if (!f.message) f.message = `cross-field tension: ${c.reason}`;
      }
    }
  }
  return conflicts.map((c) => ({ keys: c.keys, reason: c.reason, severity: c.severity }));
}

// ── Stage 1: structured specs (extracted + verified) ─────────────────────────

function buildSpecField(
  spec: EnrichField,
  gen: FieldGeneration | undefined,
  outcome: FieldOutcome,
  known: Record<string, unknown>,
  ctx: VerifyContext,
  cfg: CalibrationConfig
): FieldResult {
  const action = isEmpty(known[spec.key]) ? "fill" : "improve";

  if (!gen || isEmpty(gen.value)) {
    return {
      key: spec.key,
      tier: spec.tier,
      kind: "spec",
      ...(spec.group ? { group: spec.group } : {}),
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
    kind: "spec",
    ...(spec.group ? { group: spec.group } : {}),
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

// ── Stage 2: synthesized content (composed + compositionally verified) ───────

function buildContentField(
  spec: EnrichField,
  gen: FieldGeneration | undefined,
  known: Record<string, unknown>,
  ctx: VerifyContext,
  cfg: CalibrationConfig
): FieldResult {
  const action = isEmpty(known[spec.key]) ? "fill" : "improve";
  const base = {
    key: spec.key,
    tier: spec.tier,
    kind: "content" as const,
    ...(spec.group ? { group: spec.group } : {}),
    ...(spec.contentType ? { contentType: spec.contentType } : {}),
  };

  if (!gen || isEmpty(gen.value)) {
    return { ...base, raw: gen?.value ?? null, status: "missing", grounding: "inferred", support: 0, modelConfidence: gen?.confidence ?? 0, calibratedConfidence: 0, accepted: false, proposable: false, action };
  }

  const outcome = validateContentField(spec, gen.value);
  if (outcome.status === "missing") {
    return { ...base, raw: gen.value, status: "missing", grounding: "inferred", support: 0, modelConfidence: gen.confidence, calibratedConfidence: 0, accepted: false, proposable: false, action };
  }

  const verdict = verifyContentField(outcome.normalized ?? gen.value, ctx);
  const { calibratedConfidence, accepted, proposable } = calibrateContent(
    { modelConfidence: gen.confidence, support: verdict.support, grounding: verdict.grounding, status: outcome.status },
    cfg
  );

  return {
    ...base,
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

interface Usage {
  promptTokens: number;
  completionTokens: number;
}

function addUsage(a: Usage | undefined, b: { promptTokens: number; completionTokens: number } | undefined): Usage | undefined {
  if (!b) return a;
  return { promptTokens: (a?.promptTokens ?? 0) + b.promptTokens, completionTokens: (a?.completionTokens ?? 0) + b.completionTokens };
}

export async function enrichProduct(input: EnrichmentInput, deps: EnrichDeps): Promise<EnrichmentResult> {
  const cfg = deps.calibration ?? DEFAULT_CALIBRATION;
  const specFields = input.schema.filter((f) => f.kind !== "content");
  const contentFields = input.schema.filter((f) => f.kind === "content");

  const leaf = toLeafSchema(input.nodeId, specFields);
  const known = input.product.knownAttrs ?? {};
  const completenessBefore = validateAttributes(leaf, known).completeness;
  const contentQualityBefore = scoreKnownContent(contentFields, known);

  let model = deps.model;
  let usage: Usage | undefined;
  let costUsd: number | undefined;
  const accCost = (m: string, u: { promptTokens: number; completionTokens: number } | undefined) => {
    if (deps.provider.estimateCost && u) {
      costUsd = (costUsd ?? 0) + deps.provider.estimateCost(m, { ...u, totalTokens: u.promptTokens + u.completionTokens });
    }
  };

  const empty = (): EnrichmentResult => ({
    nodeId: input.nodeId,
    fields: [
      ...specFields.map((spec) => buildSpecField(spec, undefined, { key: spec.key, tier: spec.tier, status: "missing" }, known, buildVerifyContext(input.product), cfg)),
      ...contentFields.map((spec) => buildContentField(spec, undefined, known, buildVerifyContext(input.product), cfg)),
    ],
    candidates: [],
    completenessBefore,
    completenessAfter: completenessBefore,
    completenessProposed: completenessBefore,
    contentQualityBefore,
    contentQualityProposed: contentQualityBefore,
    groundingRate: 0,
    contentGroundingRate: 0,
    proposedInferred: 0,
    unverifiedCount: 0,
    model,
  });

  // ── STAGE 1: specs ─────────────────────────────────────────────────────────
  const ctx = buildVerifyContext(input.product);
  let specResults: FieldResult[] = [];
  let candidates: EnrichmentResult["candidates"] = [];

  if (specFields.length > 0) {
    try {
      const res = await deps.provider.chatCompletion({
        model: deps.model,
        messages: buildEnrichmentPrompt({ ...input, schema: specFields }),
        // Groq counts (input + max_tokens) against the per-minute TPM limit
        // (6000 on the free-tier fallback model), so an over-large reservation
        // 413s a perfectly small request. 3000 covers any enrichment completion
        // (specs are tiny; content is a few hundred tokens) and halves daily burn.
        maxTokens: deps.maxTokens ?? 3000,
        temperature: deps.temperature ?? 0.2,
        jsonMode: deps.jsonMode ?? true,
      });
      const parsed = parseEnrichmentResponse(res.content);
      if (res.model) model = res.model;
      usage = addUsage(usage, res.usage);
      accCost(res.model ?? model, res.usage);

      const genByKey = new Map(parsed.fields.map((f) => [f.key, f]));
      const genMap: Record<string, unknown> = {};
      for (const spec of specFields) {
        const g = genByKey.get(spec.key);
        if (g && !isEmpty(g.value)) genMap[spec.key] = g.value;
      }
      const outcomeByKey = new Map(validateAttributes(leaf, genMap).fields.map((o) => [o.key, o]));
      specResults = specFields.map((spec) =>
        buildSpecField(spec, genByKey.get(spec.key), outcomeByKey.get(spec.key) ?? { key: spec.key, tier: spec.tier, status: "missing" }, known, ctx, cfg)
      );
      candidates = parsed.candidates;
    } catch (err) {
      return { ...empty(), error: (err as Error).message };
    }
  }

  // ── STAGE 2: content (grounded in the now-confirmed facts) ──────────────────
  // Confirmed facts = the merchant's known attrs ∪ the specs we just grounded.
  // (Pre-consistency: content is composed from what stage 1 accepted; a later
  // cross-field conflict can then flag content that leaned on a contradicted spec.)
  const confirmedFacts = { ...known, ...buildSpecMaps(specResults).accepted };
  const contentCtx = buildVerifyContext({
    ...(input.product.title ? { title: input.product.title } : {}),
    ...(input.product.brand ? { brand: input.product.brand } : {}),
    ...(input.product.description ? { description: input.product.description } : {}),
    sourceCategory: [input.nodePath ?? input.nodeId, input.product.sourceCategory].filter(Boolean).join(" "),
    knownAttrs: confirmedFacts,
  });

  let contentResults: FieldResult[] = [];
  let contentError: string | undefined;
  if (contentFields.length > 0) {
    try {
      const res = await deps.provider.chatCompletion({
        model: deps.model,
        messages: buildContentPrompt({
          nodePath: input.nodePath ?? input.nodeId,
          confirmedFacts,
          ...(input.product.title ? { title: input.product.title } : {}),
          ...(input.product.brand ? { brand: input.product.brand } : {}),
          ...(input.product.description ? { description: input.product.description } : {}),
          fields: contentFields,
        }),
        // Content is the BIG response (10+ copy fields: description, bullets, FAQ,
        // pros/cons…), and models with hidden "thinking" (e.g. gemini-2.5-flash)
        // spend output budget before emitting JSON — so an under-sized cap truncates
        // the JSON and the whole stage is lost. Give content its own generous budget.
        maxTokens: deps.contentMaxTokens ?? Math.max(deps.maxTokens ?? 0, 8000),
        temperature: deps.temperature ?? 0.4,
        jsonMode: deps.jsonMode ?? true,
      });
      const parsed = parseEnrichmentResponse(res.content);
      if (res.model) model = res.model;
      usage = addUsage(usage, res.usage);
      accCost(res.model ?? model, res.usage);
      const genByKey = new Map(parsed.fields.map((f) => [f.key, f]));
      contentResults = contentFields.map((spec) => buildContentField(spec, genByKey.get(spec.key), known, contentCtx, cfg));
    } catch (err) {
      // Content failure is non-fatal — the grounded specs are still valuable — but
      // we surface the reason (was silently swallowed) so a broken content stage is
      // diagnosable instead of just showing 0 content quality.
      contentError = (err as Error).message;
      contentResults = contentFields.map((spec) => buildContentField(spec, undefined, known, contentCtx, cfg));
    }
  }

  const fields = [...specResults, ...contentResults];

  // ── Cross-field consistency (optional, post-both-stages) ─────────────────────
  // Mutates `fields` in place (hard conflicts -> contradicted; soft -> penalized),
  // so every score below reflects the audited state.
  const consistencyFlags = deps.consistency
    ? await applyConsistency(fields, deps.consistency, cfg)
    : undefined;

  // ── Scores (rebuilt AFTER any consistency downgrades) ────────────────────────
  const { accepted: acceptedSpecMap, proposable: proposableSpecMap } = buildSpecMaps(specResults);
  const completenessAfter = validateAttributes(leaf, acceptedSpecMap).completeness;
  const completenessProposed = validateAttributes(leaf, proposableSpecMap).completeness;

  const proposableContent = new Map(contentResults.filter((f) => f.proposable).map((f) => [f.key, f]));
  const contentQualityProposed = scoreContent(contentFields, proposableContent);

  const acceptedFields = specResults.filter((f) => f.accepted);
  const grounded = acceptedFields.filter((f) => f.grounding === "grounded" || f.grounding === "weak").length;
  const groundingRate = acceptedFields.length === 0 ? 0 : grounded / acceptedFields.length;

  const propContentArr = [...proposableContent.values()];
  const contentGrounded = propContentArr.filter((f) => f.grounding === "grounded" || f.grounding === "weak").length;
  const contentGroundingRate = propContentArr.length === 0 ? 0 : contentGrounded / propContentArr.length;

  const proposedInferred = specResults.filter((f) => f.proposable && !f.accepted && f.grounding === "inferred").length;
  const unverifiedCount = specResults.filter((f) => f.grounding === "unverified").length;

  return {
    nodeId: input.nodeId,
    fields,
    candidates,
    completenessBefore,
    completenessAfter,
    completenessProposed,
    contentQualityBefore,
    contentQualityProposed,
    groundingRate,
    contentGroundingRate,
    proposedInferred,
    unverifiedCount,
    ...(consistencyFlags ? { consistencyFlags } : {}),
    ...(contentError ? { contentError } : {}),
    model,
    ...(usage ? { usage } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}
