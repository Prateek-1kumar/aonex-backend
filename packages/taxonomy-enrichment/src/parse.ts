// Robust parsing of the model's JSON response. LLMs wrap JSON in fences, emit
// `null` for "absent", and occasionally fumble a sub-object — none of which
// should sink the whole enrichment. We isolate, parse, and coerce leniently.

import { z } from "zod";
import type { CandidateAttribute, FieldGeneration } from "./types.js";

export class EnrichmentParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "EnrichmentParseError";
  }
}

function nullish<T extends z.ZodTypeAny>(inner: T) {
  return inner.nullish().transform((v): z.infer<T> | undefined => v ?? undefined);
}

const FieldSchema = z.object({
  value: z.unknown(),
  confidence: nullish(z.number()),
  evidence: nullish(z.string()),
  inferred: nullish(z.boolean()),
  reasoning: nullish(z.string()),
});

const CandidateSchema = z.object({
  key: z.string().min(1),
  label: nullish(z.string()),
  dataType: nullish(z.enum(["string", "number", "boolean", "array"])),
  value: z.unknown(),
  unit: nullish(z.string()),
  reasoning: nullish(z.string()),
});

const ResponseSchema = z.object({
  fields: z.record(z.string(), FieldSchema).catch({}).default({}),
  candidates: z.array(CandidateSchema).catch([]).default([]),
});

export interface ParsedEnrichment {
  fields: FieldGeneration[];
  candidates: CandidateAttribute[];
}

/** Strip markdown fences / prose and isolate the JSON object body. Shared with
 *  the consistency auditor, which speaks the same fenced-JSON dialect. */
export function isolateJson(content: string): string {
  let t = content.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence?.[1]) t = fence[1].trim();
  if (t.startsWith("{")) return t;
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  return first !== -1 && last > first ? t.slice(first, last + 1) : t;
}

/** Clamp a possibly-missing/garbage confidence into [0,1] with a neutral default. */
function normConfidence(c: number | undefined): number {
  if (typeof c !== "number" || Number.isNaN(c)) return 0.5;
  // Tolerate models that answer on a 0..100 scale.
  const v = c > 1 ? c / 100 : c;
  return Math.max(0, Math.min(1, v));
}

export function parseEnrichmentResponse(content: string): ParsedEnrichment {
  const json = isolateJson(content);
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    throw new EnrichmentParseError(`model response was not valid JSON: ${(err as Error).message}`, content);
  }
  const parsed = ResponseSchema.safeParse(obj);
  if (!parsed.success) {
    throw new EnrichmentParseError(`model response failed schema validation: ${parsed.error.message}`, content);
  }

  const fields: FieldGeneration[] = Object.entries(parsed.data.fields).map(([key, f]) => ({
    key,
    value: f.value,
    confidence: normConfidence(f.confidence),
    ...(f.evidence ? { evidence: f.evidence } : {}),
    ...(f.inferred !== undefined ? { inferred: f.inferred } : {}),
    ...(f.reasoning ? { reasoning: f.reasoning } : {}),
  }));

  const candidates: CandidateAttribute[] = parsed.data.candidates.map((c) => ({
    key: c.key,
    ...(c.label ? { label: c.label } : {}),
    ...(c.dataType ? { dataType: c.dataType } : {}),
    value: c.value,
    ...(c.unit ? { unit: c.unit } : {}),
    ...(c.reasoning ? { reasoning: c.reasoning } : {}),
  }));

  return { fields, candidates };
}
