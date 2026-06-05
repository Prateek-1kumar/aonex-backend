// Catalog enrichment — turn a parsed model response into a reviewable proposal.
//
// Diffs each filled field against the product's current values, validates against
// the typed schema (enum/dataType — invalid is FLAGGED, not dropped), dedupes
// discovered candidates, and projects the completeness score delta.

import {
  scoreCompletenessPercent,
  getArchetype,
  PROTECTED_KEYS,
  type ActiveSchema,
  type ResolvedField,
  type AttrDataType,
} from "@aonex/archetypes";
import type { ParsedEnrichment } from "./parse.js";
import type {
  CandidateAttribute,
  EnrichmentProposal,
  ProductSnapshot,
  ProposalField,
} from "./types.js";

function isNumeric(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));
}

function validateValue(field: ResolvedField, value: unknown): { valid: boolean; error?: string } {
  switch (field.dataType) {
    case "array":
      if (!Array.isArray(value)) return { valid: false, error: "expected an array" };
      break;
    case "number":
      if (!isNumeric(value)) return { valid: false, error: "expected a number" };
      break;
    case "boolean":
      if (typeof value !== "boolean") return { valid: false, error: "expected a boolean" };
      break;
    case "object":
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return { valid: false, error: "expected an object" };
      break;
    case "string":
      if (typeof value !== "string") return { valid: false, error: "expected a string" };
      break;
  }
  if (field.enumValues && field.enumValues.length > 0) {
    const allowed = new Set(field.enumValues.map((e) => e.toLowerCase()));
    const ok = (v: unknown): boolean => typeof v === "string" && allowed.has(v.toLowerCase());
    if (field.dataType === "array") {
      const bad = (value as unknown[]).filter((v) => !ok(v));
      if (bad.length > 0) return { valid: false, error: `not in allowed set: ${bad.join(", ")}` };
    } else if (!ok(value)) {
      return { valid: false, error: "value not in allowed set" };
    }
  }
  return { valid: true };
}

function inferType(v: unknown): AttrDataType {
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (v !== null && typeof v === "object") return "object";
  return "string";
}

function humanize(key: string): string {
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function presentSet(snapshot: ProductSnapshot): Set<string> {
  const s = new Set<string>(Object.keys(snapshot.current));
  if (snapshot.facts.hasTitle) s.add("title");
  if (snapshot.facts.hasPrice) s.add("base_price");
  if (snapshot.facts.hasCurrency) s.add("currency");
  if (snapshot.facts.hasIdentifier) s.add("identifier");
  return s;
}

export interface BuildProposalArgs {
  snapshot: ProductSnapshot;
  schema: ActiveSchema;
  parsed: ParsedEnrichment;
  model: string;
  promptVersion: string;
  reasoning?: string;
  usage: { promptTokens: number; completionTokens: number };
  costUsd: number;
}

export function buildProposal(args: BuildProposalArgs): EnrichmentProposal {
  const { snapshot, schema, parsed } = args;

  // ── Pass A fields ──────────────────────────────────────────────────────
  const fields: ProposalField[] = [];
  for (const field of schema.fields) {
    if (PROTECTED_KEYS.has(field.key)) continue; // defense in depth
    const pv = parsed.fields[field.key];
    if (!pv || pv.value === undefined || pv.value === null) continue;

    const before = snapshot.current[field.key] ?? null;
    const v = validateValue(field, pv.value);
    const pf: ProposalField = {
      attributeCode: field.key,
      group: field.group,
      before,
      after: pv.value,
      confidence: pv.confidence ?? 0.6,
      action: before === null ? "fill" : "improve",
      valid: v.valid,
      decision: "pending",
    };
    if (pv.reasoning) pf.reasoning = pv.reasoning;
    if (v.error) pf.validationError = v.error;
    fields.push(pf);
  }

  // ── Pass B candidates (dedup against schema + current + each other) ─────
  const known = new Set<string>([
    ...schema.fields.map((f) => f.key),
    ...Object.keys(snapshot.current),
  ]);
  const seen = new Set<string>();
  const candidates: CandidateAttribute[] = [];
  for (const c of parsed.candidates) {
    const key = c.key.trim();
    if (!key || PROTECTED_KEYS.has(key) || known.has(key) || seen.has(key)) continue;
    if (c.value === undefined || c.value === null) continue;
    seen.add(key);
    const cand: CandidateAttribute = {
      key,
      label: c.label ?? humanize(key),
      group: "descriptive",
      dataType: c.dataType ?? inferType(c.value),
      value: c.value,
      reasoning: c.reasoning ?? "",
      decision: "pending",
    };
    if (c.unit) cand.unit = c.unit;
    if (c.enumCandidates && c.enumCandidates.length > 0) cand.enumCandidates = c.enumCandidates;
    candidates.push(cand);
  }

  // ── Score delta (only VALID fields count toward the projection) ─────────
  const arch = getArchetype(schema.archetypeId) ?? getArchetype("generic");
  const before = presentSet(snapshot);
  const after = new Set(before);
  for (const f of fields) if (f.valid) after.add(f.attributeCode);
  const scoreBefore = arch ? scoreCompletenessPercent(arch, before).percent : 0;
  const scoreAfter = arch ? scoreCompletenessPercent(arch, after).percent : 0;

  const proposal: EnrichmentProposal = {
    productId: snapshot.productId,
    archetype: schema.archetypeId,
    fellBackToGeneric: schema.fellBackToGeneric,
    model: args.model,
    promptVersion: args.promptVersion,
    fields,
    candidates,
    scoreBefore: { completeness: scoreBefore },
    scoreAfter: { completeness: scoreAfter },
    costUsd: args.costUsd,
    usage: args.usage,
  };
  if (args.reasoning) proposal.reasoning = args.reasoning;
  return proposal;
}
