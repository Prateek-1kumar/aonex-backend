// Schema-conditioned enrichment prompt.
//
// Unlike a free-form "write me a listing" prompt, this is bounded by the leaf's
// attribute schema: the model fills a FIXED set of typed, enum/unit-constrained
// fields, and for each one must say what source span it grounded on and whether
// it inferred the value. Catalog-RAG examples (similar products from our own
// catalog) are shown to teach the value SHAPE, not to copy facts from.

import type { EnrichField, EnrichmentInput, RagExample } from "./types.js";

export const ENRICH_PROMPT_VERSION = "tax-enrich-v1";

/** Cap noisy enum lists (e.g. 58 sizes) so the prompt stays readable; the
 *  validator coerces/flags anything off-list regardless. */
const ENUM_DISPLAY_CAP = 30;

function describeField(f: EnrichField): string {
  const bits: string[] = [`- "${f.key}" (${f.label ?? f.key}) [${f.tier}, ${f.dataType ?? "string"}]`];
  if (f.isVariantAxis) bits.push("variant-axis");
  if (f.enumValues && f.enumValues.length > 0) {
    const shown = f.enumValues.slice(0, ENUM_DISPLAY_CAP).join(", ");
    const more = f.enumValues.length > ENUM_DISPLAY_CAP ? `, … (${f.enumValues.length} allowed)` : "";
    bits.push(`allowed: [${shown}${more}]`);
  }
  if (f.unit) bits.push(`unit: ${f.unit}${f.allowedUnits?.length ? ` (accepts ${f.allowedUnits.join("/")})` : ""}`);
  if (f.min !== undefined || f.max !== undefined) bits.push(`range: [${f.min ?? "-∞"}, ${f.max ?? "∞"}]`);
  if (f.description) bits.push(f.description);
  return bits.join(" — ");
}

function renderExamples(examples: RagExample[]): string {
  if (examples.length === 0) return "";
  const lines = examples.map((e, i) => {
    const attrs = JSON.stringify(e.attrs);
    return `  ${i + 1}. ${e.title}${e.brand ? ` (${e.brand})` : ""} -> ${attrs}`;
  });
  return `\nSIMILAR PRODUCTS FROM OUR CATALOG (reference for the SHAPE/vocabulary of good values — do NOT copy their facts onto this product):\n${lines.join("\n")}\n`;
}

export const SYSTEM = `You are a precise product-data extraction and enrichment engine for an e-commerce catalog.
You fill a FIXED attribute schema for one product. Rules — follow strictly:
- Prefer values you can READ from the product data given. For each field, quote the exact source span in "evidence".
- If a value is not stated but follows confidently from world knowledge (e.g. an iPhone runs iOS; denim jeans are cotton), you MAY provide it, but set "inferred": true and "evidence": "".
- NEVER invent specific measurements, capacities, or model-specific numbers that are not in the source. Omit the field instead.
- Respect each field's data type, allowed enum values, and unit. If unsure which enum value applies, pick the closest allowed one.
- NEVER output price, currency, stock, or identifiers (GTIN/MPN/SKU) — those are owned elsewhere.
- "confidence" is your honest 0..1 certainty for THAT value. Omit a field entirely rather than guess blindly.
- Output STRICT JSON only — no markdown, no prose.`;

export function buildEnrichmentPrompt(input: EnrichmentInput): { role: "system" | "user"; content: string }[] {
  const { product, schema } = input;
  const fieldList = schema.map(describeField).join("\n");
  const known = product.knownAttrs && Object.keys(product.knownAttrs).length > 0
    ? `\nKNOWN ATTRIBUTES (already confirmed — keep consistent, do not contradict):\n${JSON.stringify(product.knownAttrs)}`
    : "";

  const productBlock = [
    product.title ? `Title: ${product.title}` : "",
    product.brand ? `Brand: ${product.brand}` : "",
    product.sourceCategory ? `Source category: ${product.sourceCategory}` : "",
    product.description ? `Description: ${product.description}` : "",
    product.extraText ? `Details: ${product.extraText}` : "",
  ].filter(Boolean).join("\n");

  const user = `CATEGORY: ${input.nodePath ?? input.nodeId}

PRODUCT (ground truth — do not contradict):
${productBlock}${known}
${renderExamples(input.examples ?? [])}
Fill these attributes for the product. Skip a field only if you genuinely cannot determine it (don't guess):
${fieldList}

Also DISCOVER up to 4 additional attributes that genuinely matter for this product type but are not listed above (factual, type-relevant only; never price/stock/identifiers).

Return STRICT JSON with this exact shape:
{
  "fields": {
    "<attributeKey>": { "value": <typed value>, "confidence": <0..1>, "evidence": "<exact source span, or empty if inferred>", "inferred": <true|false>, "reasoning": "<short why>" }
  },
  "candidates": [
    { "key": "<snake_case>", "label": "<Human Label>", "dataType": "string|number|boolean|array", "value": <typed value>, "unit": "<optional>", "reasoning": "<why it matters>" }
  ]
}`;

  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}
