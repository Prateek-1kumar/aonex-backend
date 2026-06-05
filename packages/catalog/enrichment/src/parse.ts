// Catalog enrichment — robust parsing of the model's JSON response.

import { z } from "zod";

export class EnrichmentParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "EnrichmentParseError";
  }
}

/**
 * LLMs frequently emit `null` for an absent optional field even when told to
 * omit it (e.g. the model returns `"unit": null` for a unit-less attribute).
 * Plain `.optional()` rejects `null` and would fail the WHOLE proposal over one
 * stray null. Accept null/undefined and normalize to `undefined` so the value is
 * treated as "absent" — proposal.ts already coalesces missing values.
 */
function nullable<T extends z.ZodTypeAny>(inner: T) {
  return inner.nullish().transform((v): z.infer<T> | undefined => v ?? undefined);
}

const FieldValueSchema = z.object({
  value: z.unknown(),
  confidence: nullable(z.number().min(0).max(1)),
  reasoning: nullable(z.string()),
});

const CandidateSchema = z.object({
  key: z.string().min(1),
  label: nullable(z.string()),
  dataType: nullable(z.enum(["string", "number", "boolean", "array", "object"])),
  value: z.unknown(),
  unit: nullable(z.string()),
  enumCandidates: nullable(z.array(z.string())),
  reasoning: nullable(z.string()),
});

const ContentQualitySchema = z.object({
  score: z.number().min(0).max(100),
  coherence: nullable(z.number()),
  spelling: nullable(z.number()),
  consistency: nullable(z.number()),
  relevance: nullable(z.number()),
});

const ResponseSchema = z.object({
  fields: z.record(z.string(), FieldValueSchema).default({}),
  candidates: z.array(CandidateSchema).default([]),
  // Non-essential quality block — degrade to absent rather than fail the proposal
  // if the model returns it malformed (e.g. a null score).
  content_quality: ContentQualitySchema.optional().catch(undefined),
});

export type ParsedEnrichment = z.infer<typeof ResponseSchema>;

/** Strip markdown code fences and isolate the JSON object if the model wrapped it. */
function isolateJson(content: string): string {
  let t = content.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence?.[1]) t = fence[1].trim();
  if (t.startsWith("{")) return t;
  // Fallback: take the outermost { ... } span.
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last > first) return t.slice(first, last + 1);
  return t;
}

export function parseEnrichmentResponse(content: string): ParsedEnrichment {
  const json = isolateJson(content);
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    throw new EnrichmentParseError(
      `Model response was not valid JSON: ${(err as Error).message}`,
      content
    );
  }
  const parsed = ResponseSchema.safeParse(obj);
  if (!parsed.success) {
    throw new EnrichmentParseError(
      `Model response failed schema validation: ${parsed.error.message}`,
      content
    );
  }
  return parsed.data;
}
