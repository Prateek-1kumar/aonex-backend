// Catalog enrichment — robust parsing of the model's JSON response.

import { z } from "zod";

export class EnrichmentParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "EnrichmentParseError";
  }
}

const FieldValueSchema = z.object({
  value: z.unknown(),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().optional(),
});

const CandidateSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  dataType: z.enum(["string", "number", "boolean", "array", "object"]).optional(),
  value: z.unknown(),
  unit: z.string().optional(),
  enumCandidates: z.array(z.string()).optional(),
  reasoning: z.string().optional(),
});

const ContentQualitySchema = z.object({
  score: z.number().min(0).max(100),
  coherence: z.number().optional(),
  spelling: z.number().optional(),
  consistency: z.number().optional(),
  relevance: z.number().optional(),
});

const ResponseSchema = z.object({
  fields: z.record(z.string(), FieldValueSchema).default({}),
  candidates: z.array(CandidateSchema).default([]),
  content_quality: ContentQualitySchema.optional(),
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
