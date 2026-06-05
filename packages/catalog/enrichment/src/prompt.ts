// Catalog enrichment — prompt construction (spec §7).
//
// Two-pass, schema-conditioned: Pass A fills the resolved typed schema grounded
// in the product's current data; Pass B discovers additional type-relevant
// attributes. Protected commerce facts are never requested.
//
// v2: PIM-grade — compulsory content block (descriptions/key features/SEO),
// deep Amazon/Myntra-style category breadcrumbs, and per-field length/format
// guidance threaded from the attribute catalogue.

import type { ChatMessage } from "@aonex/ingestion-llm-extractor";
import type { ActiveSchema, ResolvedField } from "@aonex/archetypes";
import type { ProductSnapshot } from "./types.js";

export const ENRICH_PROMPT_VERSION = "enrich-v2";

/** Content fields that must always be produced richly for a premium listing. */
const COMPULSORY = [
  "description_short", "description_long", "key_features",
  "meta_title", "meta_description", "seo_keywords", "tags", "category_path",
];

function describeField(f: ResolvedField): string {
  const star = COMPULSORY.includes(f.key) ? "★ " : "";
  const parts = [`- ${star}"${f.key}" (${f.label}; ${f.dataType}; ${f.tier})`];
  if (f.enumValues && f.enumValues.length > 0) {
    parts.push(`allowed: [${f.enumValues.join(", ")}]`);
  }
  if (f.unitType) parts.push(`unit: ${f.unitType}`);
  if (f.description) parts.push(f.description);
  return parts.join(" — ");
}

const SYSTEM = `You are an expert e-commerce merchandiser, SEO/AEO strategist, and product taxonomist.
You enrich a product's catalog content to a premium PIM standard (think Amazon / Myntra / Shopify listings).
Rules — follow strictly:
- GROUND every factual attribute in the product data you are given. NEVER invent specs, materials, or measurements.
- NEVER output price, currency, stock, or identifiers (GTIN/MPN/SKU) — those are facts owned elsewhere.
- Respect the allowed enum values and data types for each requested field. Omit a field ONLY if you truly cannot produce it; the ★ compulsory fields must always be filled.
- Do NOT fabricate competitor names or claims; "comparison" is category-level positioning only.
- Write in clear, persuasive, retail-grade English. No keyword stuffing, no ALL CAPS, no emojis.
- meta_title <= 60 chars; meta_description <= 160 chars; description_short <= ~320 chars; description_long ~600-1200 chars.
- Output STRICT JSON only (no markdown, no prose). Every value carries a confidence in [0,1].`;

const CATEGORY_GUIDE = `CATEGORY (critical — deep & canonical, the way Amazon/Myntra classify):
- "category_path" MUST be an ordered breadcrumb of 4-6 levels, broad → specific, starting with a top
  department and including audience/gender where relevant. Worked examples:
    men's jeans      -> ["Home","Men","Clothing","Bottomwear","Jeans"]
    women's sneakers -> ["Home","Women","Footwear","Sports Shoes","Running Shoes"]
    smartphone       -> ["Electronics","Mobiles & Accessories","Smartphones"]
    3-seater sofa    -> ["Home","Furniture","Living Room","Sofas & Couches","3 Seater Sofas"]
    face serum       -> ["Beauty","Skincare","Face Care","Serums & Essences"]
  NEVER output a single shallow node like ["Jeans"].
- Also set "department" (top node), "audience_gender" (Men/Women/Unisex/Kids when applicable),
  "google_category" (a full Google Product Taxonomy path string), and the per-marketplace category
  fields (amazon_category, etc.) wherever you can map them confidently.`;

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

GOAL: produce a complete, conversion-ready listing. Fill EVERY field you can ground — aim for breadth
(descriptions, key features, benefits, instructions, full SEO, FAQ, deep category). Fields marked ★ are
compulsory and must always be present and well-written.

${CATEGORY_GUIDE}

PASS A — fill these typed fields (skip a non-★ field only if you cannot ground it):
${fieldList}

PASS B — DISCOVER: propose up to 6 additional attributes that genuinely matter for THIS product type
but are not in the list above (e.g. for jeans: "distressing", "thread_count"). Only real, type-relevant,
factual attributes. Never propose price/currency/stock/identifiers.

Return STRICT JSON with this exact shape:
{
  "fields": {
    "<attributeCode>": { "value": <typed value>, "confidence": <0..1>, "reasoning": "<short why>" }
  },
  "candidates": [
    { "key": "<snake_case>", "label": "<Human Label>", "dataType": "string|number|boolean|array|object",
      "value": <typed value>, "unit": "<optional>", "enumCandidates": ["..."], "reasoning": "<why it matters>" }
  ],
  "content_quality": { "score": <0..100>, "coherence": <0..10>, "spelling": <0..10>, "consistency": <0..10>, "relevance": <0..10> }
}

Notes on value shapes: "benefits" = [{"label","text"}]; "faq" = [{"q","a"}] (>=3); "pros_cons" = {"pros":[],"cons":[]};
"key_features"/"bullet_points"/"tags"/"seo_keywords" = string arrays; "category_path" = string array (4-6 levels).

Also rate the OVERALL quality of the enriched content you produced in "content_quality"
(0..100 score from coherence, spelling, consistency, relevance).`;

  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}
