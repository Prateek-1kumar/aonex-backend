// Grounded content-synthesis prompt (Stage 2).
//
// Stage 1 fills the structured spec schema. Stage 2 takes the CONFIRMED facts
// (the merchant's known attributes ∪ the specs stage 1 just grounded) plus the
// taxonomy category, and writes the listing/SEO/marketing/AEO content FROM those
// facts. The model is told, hard, that it may frame with category world-knowledge
// but may NEVER introduce a new measurement / spec / material — that is what keeps
// this "no random filling" and provably connected to the catalog.

import type { EnrichField } from "./types.js";

export const CONTENT_PROMPT_VERSION = "tax-content-v1";

export interface ContentPromptInput {
  nodePath: string;
  /** The only source of truth for facts: known attrs ∪ stage-1 accepted specs. */
  confirmedFacts: Record<string, unknown>;
  title?: string;
  brand?: string;
  description?: string;
  fields: EnrichField[];
}

const SHAPE: Record<NonNullable<EnrichField["contentType"]>, string> = {
  text: "a string",
  string_list: "an array of short strings",
  qa_list: 'an array of objects {"q": "question", "a": "answer"}',
  pros_cons: 'an object {"pros": ["..."], "cons": ["..."]}',
};

function describeContentField(f: EnrichField): string {
  const ct = f.contentType ?? "text";
  const limits: string[] = [];
  if (f.constraints?.maxLen) limits.push(`max ${f.constraints.maxLen} chars${ct === "text" ? "" : " per item"}`);
  if (f.constraints?.minItems) limits.push(`min ${f.constraints.minItems} items`);
  if (f.constraints?.maxItems) limits.push(`max ${f.constraints.maxItems} items`);
  const limitStr = limits.length ? ` (${limits.join(", ")})` : "";
  return `- "${f.key}" (${f.label ?? f.key}) — ${SHAPE[ct]}${limitStr}: ${f.description ?? ""}`;
}

export const CONTENT_SYSTEM = `You are an expert e-commerce copywriter and SEO/AEO specialist. You write listing content for ONE product using the CONFIRMED FACTS provided.

ABSOLUTE RULES — follow strictly:
- The CONFIRMED FACTS (brand, category, and confirmed attributes) are your ONLY source of product facts.
- You MAY use general knowledge about the product CATEGORY to frame copy naturally (tone, common use cases, generic phrasing).
- You MUST NEVER state a specific measurement, capacity, dimension, weight, size, count, material, certification, model number, or any numeric spec that is not present in the CONFIRMED FACTS. Inventing such a fact is the worst possible error.
- If you cannot write a field truthfully from the facts, OMIT that field. A missing field is far better than a fabricated one.
- Every concrete claim must trace to a confirmed fact. Adjectives/benefits are fine; invented specs are not.
- Respect each field's shape and length/count limits exactly.
- Keep brand and product type consistent with the facts; never contradict a confirmed attribute.
- Output STRICT JSON only — no markdown, no prose outside the JSON.`;

export function buildContentPrompt(input: ContentPromptInput): { role: "system" | "user"; content: string }[] {
  const facts = [
    input.title ? `Title: ${input.title}` : "",
    input.brand ? `Brand: ${input.brand}` : "",
    `Category: ${input.nodePath}`,
    Object.keys(input.confirmedFacts).length > 0
      ? `Confirmed attributes: ${JSON.stringify(input.confirmedFacts)}`
      : "",
    input.description ? `Existing description (for tone + extra facts; still never invent): ${input.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const fieldList = input.fields.map(describeContentField).join("\n");

  const user = `CONFIRMED FACTS (the ONLY source of truth — do not contradict or exceed):
${facts}

Write the following content fields for this product. Skip any field you cannot ground in the facts above:
${fieldList}

Return STRICT JSON with this exact shape:
{
  "fields": {
    "<fieldKey>": { "value": <shaped value>, "confidence": <0..1>, "evidence": "<which confirmed facts you used>", "reasoning": "<short why>" }
  }
}`;

  return [
    { role: "system", content: CONTENT_SYSTEM },
    { role: "user", content: user },
  ];
}
