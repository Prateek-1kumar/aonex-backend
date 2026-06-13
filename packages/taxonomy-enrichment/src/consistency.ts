// Cross-field consistency auditor (Gap B).
//
// verify.ts + calibrate.ts judge every field in ISOLATION against the source.
// They cannot catch a contradiction BETWEEN two fields the model produced — e.g.
// size="Large" while the description says "fits petite", or material="Leather"
// while a feature bullet says "100% cotton". This is a single cheap LLM pass over
// the FINAL field set (specs + content) that flags such internal contradictions.
//
// It is OPTIONAL and INJECTED (EnrichDeps.consistency): the core engine and its
// unit tests never need a live model. Best-effort — a parse/call failure flags
// nothing rather than sinking enrichment.

import { z } from "zod";
import { isolateJson } from "./parse.js";
import { valueToText } from "./text.js";
import type { ChatProvider, FieldResult } from "./types.js";

export interface ConsistencyDeps {
  provider: ChatProvider;
  model: string;
  maxTokens?: number;
}

export type ConsistencySeverity = "hard" | "soft";

export interface ConsistencyConflict {
  /** Field keys that contradict each other (>= 1 after validation). */
  keys: string[];
  /** Human-readable explanation of the contradiction. */
  reason: string;
  /** hard = mutually exclusive facts (reject); soft = tension/doubt (penalize). */
  severity: ConsistencySeverity;
}

const SYSTEM =
  "You are a product-data consistency auditor. You are given the proposed attributes " +
  "and listing copy for ONE product. Find pairs (or groups) of fields whose values " +
  "directly CONTRADICT each other — e.g. size says one thing but the description implies " +
  "another, a material conflicts with a feature, a color in copy disagrees with the color " +
  "attribute. Judge ONLY internal contradictions between the given fields. Do NOT invent " +
  "facts, do NOT flag mere absence, and do NOT flag values that are simply unrelated. " +
  "Classify each conflict: severity \"hard\" = the two values cannot both be true; " +
  "severity \"soft\" = a tension or likely mismatch worth a human look. " +
  'Output STRICT JSON only: {"conflicts":[{"keys":["a","b"],"reason":"...","severity":"hard|soft"}]}. ' +
  'If there are no contradictions, output {"conflicts":[]}.';

/** One row per field handed to the auditor. Values are flattened + truncated. */
function buildUserPrompt(items: { key: string; kind: string; value: string }[]): string {
  const lines = items.map((it) => `- ${it.key} (${it.kind}): ${it.value}`).join("\n");
  return `FIELDS:\n${lines}\n\nReturn the conflicts JSON.`;
}

const ConflictSchema = z.object({
  keys: z.array(z.string()).min(1),
  reason: z.string().catch("").default(""),
  severity: z.enum(["hard", "soft"]).catch("soft").default("soft"),
});
const ResponseSchema = z.object({
  conflicts: z.array(ConflictSchema).catch([]).default([]),
});

/** Flatten a field value to a short string for the prompt (cap runaway copy). */
function fieldText(f: FieldResult): string {
  const t = valueToText(f.normalized ?? f.raw).replace(/\s+/g, " ").trim();
  return t.length > 240 ? `${t.slice(0, 240)}…` : t;
}

/**
 * Audit the final field set for internal contradictions. Only fields that would
 * actually be applied or surfaced (accepted || proposable) are considered — there
 * is no point flagging values the engine already suppressed. Returns the conflicts
 * whose keys map back to considered fields; the caller applies the penalties.
 */
export async function checkConsistency(
  fields: FieldResult[],
  deps: ConsistencyDeps
): Promise<ConsistencyConflict[]> {
  const considered = fields.filter((f) => f.accepted || f.proposable);
  if (considered.length < 2) return []; // nothing to cross-check

  const items = considered.map((f) => ({ key: f.key, kind: f.kind ?? "spec", value: fieldText(f) }));

  let content: string;
  try {
    const res = await deps.provider.chatCompletion({
      model: deps.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildUserPrompt(items) },
      ],
      maxTokens: deps.maxTokens ?? 600,
      temperature: 0,
      jsonMode: true,
    });
    content = res.content;
  } catch {
    return [];
  }

  let obj: unknown;
  try {
    obj = JSON.parse(isolateJson(content));
  } catch {
    return [];
  }
  const parsed = ResponseSchema.safeParse(obj);
  if (!parsed.success) return [];

  // Keep only conflicts referencing fields we actually considered.
  const valid = new Set(considered.map((f) => f.key));
  return parsed.data.conflicts
    .map((c) => ({ keys: c.keys.filter((k) => valid.has(k)), reason: c.reason, severity: c.severity }))
    .filter((c) => c.keys.length >= 1);
}
