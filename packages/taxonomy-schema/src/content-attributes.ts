// The UNIVERSAL CONTENT LAYER — the half of enrichment the taxonomy migration
// dropped.
//
// The taxonomy node schema (node_attributes ⨝ attribute_definitions) covers
// STRUCTURED specs only (fit, fabric, storage…). A product is not "good" with a
// filled spec sheet alone — it needs the merchandising/discoverability content a
// storefront and search engine actually consume: a real description, feature
// bullets, SEO title/description/keywords, FAQ, etc.
//
// These attributes apply to EVERY leaf (applies_universally), so they live here
// as the code source of truth (NOT per-node rows). `contentEnrichFields()` merges
// them into every node's schema in buildLeafSchemaIndex; `contentAttributeDefs()`
// seeds them into attribute_definitions for the Lab / promotion infra to see.
//
// Hard rule baked into the model: content is SYNTHESIZED from already-confirmed
// facts, never invented. The constraints + tiers here drive both the synthesis
// prompt and the content-quality score.

import type { ContentConstraints, ContentType, EnrichField, Tier } from "@aonex/taxonomy-enrichment";

/** A universal content/SEO/marketing/AEO attribute. */
export interface ContentAttribute {
  key: string;
  label: string;
  /** UI/scoring group — also the attribute_definitions.enrichment_group value. */
  group: "content" | "marketing" | "seo" | "aeo";
  contentType: ContentType;
  /** Tier within the content-quality rubric (required dominates). */
  tier: Tier;
  /** Weight within its tier. */
  weight: number;
  constraints?: ContentConstraints;
  /** Per-field guidance surfaced to the synthesis prompt (format, voice, limits). */
  description: string;
}

/** dataType stored on attribute_definitions for each content shape. */
const DATA_TYPE: Record<ContentType, string> = {
  text: "string",
  string_list: "array",
  qa_list: "array",
  pros_cons: "object",
};

export const CONTENT_ATTRIBUTES: readonly ContentAttribute[] = [
  // ── Core copy (what the storefront renders) ────────────────────────────────
  {
    key: "description_long",
    label: "Description",
    group: "content",
    contentType: "text",
    tier: "required",
    weight: 0.9,
    constraints: { maxLen: 1200 },
    description:
      "Rich body copy, ~400-1200 chars, 2-4 short paragraphs. Synthesize the confirmed attributes into a benefit-led narrative. Do NOT state any spec, measurement or material not in the confirmed facts.",
  },
  {
    key: "description_short",
    label: "Short Description",
    group: "content",
    contentType: "text",
    tier: "recommended",
    weight: 0.5,
    constraints: { maxLen: 320 },
    description: "Punchy one-or-two-sentence summary, <= 320 chars, lead with the strongest confirmed selling point.",
  },

  // ── Marketing ──────────────────────────────────────────────────────────────
  {
    key: "key_features",
    label: "Key Features",
    group: "marketing",
    contentType: "string_list",
    tier: "required",
    weight: 0.8,
    constraints: { minItems: 4, maxItems: 8, maxLen: 90 },
    description: "4-8 concise feature bullets, each a single benefit/spec phrase grounded in a confirmed fact. No marketing fluff without a fact behind it.",
  },
  {
    key: "bullet_points",
    label: "Bullet Points",
    group: "marketing",
    contentType: "string_list",
    tier: "recommended",
    weight: 0.4,
    constraints: { minItems: 3, maxItems: 6, maxLen: 120 },
    description: "3-6 marketplace-style bullets (Amazon-style). May elaborate a feature into a fuller sentence; still fact-grounded.",
  },
  {
    key: "highlights",
    label: "Highlights",
    group: "marketing",
    contentType: "string_list",
    tier: "optional",
    weight: 0.3,
    constraints: { minItems: 2, maxItems: 5, maxLen: 60 },
    description: "2-5 ultra-short hero phrases (2-4 words) for badges/chips.",
  },
  {
    key: "target_audience",
    label: "Target Audience",
    group: "marketing",
    contentType: "string_list",
    tier: "optional",
    weight: 0.3,
    constraints: { minItems: 1, maxItems: 4, maxLen: 40 },
    description: "Who the product is for, inferred only from the category/attributes (e.g. 'Men', 'Runners', 'Gamers'). No invented demographics.",
  },

  // ── SEO ────────────────────────────────────────────────────────────────────
  {
    key: "meta_title",
    label: "Meta Title",
    group: "seo",
    contentType: "text",
    tier: "required",
    weight: 0.6,
    constraints: { maxLen: 60 },
    description: "SEO <title>, <= 60 chars. Pattern: Brand + key attribute(s) + product type. Front-load the most-searched terms.",
  },
  {
    key: "meta_description",
    label: "Meta Description",
    group: "seo",
    contentType: "text",
    tier: "required",
    weight: 0.7,
    constraints: { maxLen: 160 },
    description: "SEO meta description, 120-160 chars, compelling, includes the primary keyword and brand. One sentence, no fabricated claims.",
  },
  {
    key: "seo_keywords",
    label: "SEO Keywords",
    group: "seo",
    contentType: "string_list",
    tier: "required",
    weight: 0.7,
    constraints: { minItems: 5, maxItems: 15, maxLen: 50 },
    description: "5-15 search phrases buyers would type, built ONLY from brand + product type + confirmed attributes + category path (e.g. 'slim fit blue jeans', 'mens denim'). No competitor or unrelated terms.",
  },
  {
    key: "tags",
    label: "Tags",
    group: "seo",
    contentType: "string_list",
    tier: "recommended",
    weight: 0.4,
    constraints: { minItems: 3, maxItems: 12, maxLen: 30 },
    description: "3-12 single/short-word storefront filter tags drawn from confirmed attributes and the category.",
  },
  {
    key: "search_keywords",
    label: "Search Keywords",
    group: "seo",
    contentType: "string_list",
    tier: "optional",
    weight: 0.2,
    constraints: { minItems: 3, maxItems: 12, maxLen: 40 },
    description: "Backend search synonyms / alternate spellings (e.g. 'tee' for t-shirt, 'sneakers' for trainers). Synonyms of confirmed terms only.",
  },
  {
    key: "url_slug",
    label: "URL Slug",
    group: "seo",
    contentType: "text",
    tier: "optional",
    weight: 0.2,
    constraints: { maxLen: 80 },
    description: "Lowercase, hyphenated, ASCII slug from brand + product type + 1-2 key attributes (e.g. 'nike-slim-fit-blue-jeans').",
  },

  // ── AEO / GEO (Answer / Generative Engine Optimization) ────────────────────
  {
    key: "faq",
    label: "FAQ",
    group: "aeo",
    contentType: "qa_list",
    tier: "recommended",
    weight: 0.5,
    constraints: { minItems: 3, maxItems: 6, maxLen: 300 },
    description: "3-6 buyer Q&As answerable from the confirmed facts (size, material, care, compatibility). Never answer a question the facts don't cover — drop it instead.",
  },
  {
    key: "pros_cons",
    label: "Pros & Cons",
    group: "aeo",
    contentType: "pros_cons",
    tier: "optional",
    weight: 0.3,
    constraints: { minItems: 2, maxItems: 5, maxLen: 90 },
    description: "{ pros: string[], cons: string[] } — balanced, factual. Cons must be neutral characteristics implied by the attributes (e.g. 'hand wash only'), never invented defects.",
  },
  {
    key: "use_cases",
    label: "Use Cases",
    group: "aeo",
    contentType: "string_list",
    tier: "optional",
    weight: 0.3,
    constraints: { minItems: 2, maxItems: 5, maxLen: 80 },
    description: "2-5 scenarios/occasions the product fits, grounded in category + attributes (e.g. 'everyday casual wear', 'gym workouts').",
  },
  {
    key: "aeo_summary",
    label: "AEO Summary",
    group: "aeo",
    contentType: "text",
    tier: "optional",
    weight: 0.3,
    constraints: { maxLen: 280 },
    description: "A single neutral paragraph an AI assistant could quote verbatim to describe the product. Facts only.",
  },
] as const;

const byKey = new Map(CONTENT_ATTRIBUTES.map((c) => [c.key, c]));

/** Is this canonical key part of the universal content layer? */
export const isContentKey = (key: string): boolean => byKey.has(key);

export const contentGroupFor = (key: string): string | undefined => byKey.get(key)?.group;

/** The content layer projected as EnrichField[] (merged into every leaf schema). */
export function contentEnrichFields(): EnrichField[] {
  return CONTENT_ATTRIBUTES.map((c) => ({
    key: c.key,
    tier: c.tier,
    label: c.label,
    description: c.description,
    group: c.group,
    kind: "content" as const,
    contentType: c.contentType,
    weight: c.weight,
    ...(c.constraints ? { constraints: c.constraints } : {}),
  }));
}

/** The content layer projected as attribute_definitions rows (DB seed). */
export interface ContentAttributeDefRow {
  canonicalKey: string;
  label: string;
  dataType: string;
  enrichmentGroup: string;
  appliesUniversally: boolean;
  description: string;
  validationJson: Record<string, unknown> | null;
  origin: string;
  status: string;
  provenance: { sources?: { system: string; ref?: string }[] } | null;
}

export function contentAttributeDefs(): ContentAttributeDefRow[] {
  return CONTENT_ATTRIBUTES.map((c) => ({
    canonicalKey: c.key,
    label: c.label,
    dataType: DATA_TYPE[c.contentType],
    enrichmentGroup: c.group,
    appliesUniversally: true,
    description: c.description,
    validationJson: { contentType: c.contentType, ...(c.constraints ?? {}) },
    origin: "seed",
    status: "active",
    provenance: { sources: [{ system: "aonex", ref: "content-layer" }] },
  }));
}
