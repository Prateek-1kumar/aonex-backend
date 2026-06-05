// Catalog enrichment — prompt construction (spec §7).
//
// Two-pass, schema-conditioned: Pass A fills the resolved typed schema grounded
// in the product's current data; Pass B discovers additional type-relevant
// attributes. Protected commerce facts are never requested.

import type { ChatMessage } from "@aonex/ingestion-llm-extractor";
import type { ActiveSchema, ResolvedField } from "@aonex/archetypes";
import type { ProductSnapshot } from "./types.js";

export const ENRICH_PROMPT_VERSION = "enrich-v1";

function describeField(f: ResolvedField): string {
  const parts = [`- "${f.key}" (${f.label}; ${f.dataType}; group=${f.group})`];
  if (f.enumValues && f.enumValues.length > 0) {
    parts.push(`allowed: [${f.enumValues.join(", ")}]`);
  }
  if (f.unitType) parts.push(`unit: ${f.unitType}`);
  return parts.join(" — ");
}

const SYSTEM = `You are an expert e-commerce merchandiser and product taxonomist.
You enrich a product's catalog content. Rules — follow strictly:
- GROUND every factual attribute in the product data you are given. NEVER invent specs.
- NEVER output price, currency, stock, or identifiers (GTIN/MPN/SKU) — those are facts owned elsewhere.
- Respect the allowed enum values and data types for each requested field. Omit a field if you cannot fill it confidently.
- Do NOT fabricate competitor names or claims; "comparison" must be category-level positioning only.
- category_path must be a DEEP ordered breadcrumb to a brand/series leaf, e.g.
  ["Home","Clothing","Men Clothing","Jeans","<Brand> Jeans"].
- meta_title <= 60 chars; meta_description <= 160 chars.
- Output STRICT JSON only (no markdown, no prose). Every value carries a confidence in [0,1].`;

/** Build the chat messages for one enrichment pass. */
export function buildEnrichmentPrompt(
  snapshot: ProductSnapshot,
  schema: ActiveSchema
): ChatMessage[] {
  const fieldList = schema.fields.map(describeField).join("\n");
  const current = JSON.stringify(snapshot.current, null, 2);

  const user = `PRODUCT (current known data — ground truth, do not contradict):
${current}

ARCHETYPE: ${schema.archetypeId}${schema.fellBackToGeneric ? " (generic fallback)" : ""}

PASS A — fill these fields where you can (skip ones you cannot ground):
${fieldList}

PASS B — DISCOVER: propose up to 6 additional attributes that genuinely matter for THIS
product type but are not in the list above (e.g. for jeans: "rise", "distressing"). Only
real, type-relevant, factual attributes. Never propose price/currency/stock/identifiers.

Return STRICT JSON with this exact shape:
{
  "fields": {
    "<attributeCode>": { "value": <typed value>, "confidence": <0..1>, "reasoning": "<short why>" }
  },
  "candidates": [
    { "key": "<snake_case>", "label": "<Human Label>", "dataType": "string|number|boolean|array|object",
      "value": <typed value>, "unit": "<optional>", "enumCandidates": ["..."], "reasoning": "<why it matters>" }
  ]
}`;

  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}
