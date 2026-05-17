#!/usr/bin/env bun
/**
 * Read scripts/seed/google-product-taxonomy.txt; for each canonical path,
 * prompt Groq Llama 3.3 70B for a JSON Schema 2019-09 document that captures
 * the attributes a typical product in that category would have. Output one
 * JSON file per category under seed/category-schemas/.
 *
 * Idempotent: skips categories already written. Cost: ~$0.20-0.40 total for
 * 150 categories at ~3K tokens each.
 *
 * Usage:
 *   GROQ_API_KEY=... bun --bun scripts/seed/draft-category-schemas.ts
 *   GROQ_API_KEY=... bun --bun scripts/seed/draft-category-schemas.ts --only=electronics/televisions
 *
 * Falls back to OPENAI_API_KEY when GROQ_API_KEY is unset (user's setup
 * routes Groq through the OpenAI-compatible key var).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OpenAIProvider } from "@aonex/ingestion-llm-extractor";

const TAXONOMY_FILE = "scripts/seed/google-product-taxonomy.txt";
const OUT_DIR = "seed/category-schemas";
const AUTHORITATIVE_LIST: string[] = JSON.parse(
  readFileSync(join(OUT_DIR, "authoritative-list.json"), "utf-8")
);

const apiKey = process.env.GROQ_API_KEY ?? process.env.OPENAI_API_KEY;
if (!apiKey) {
  // eslint-disable-next-line no-console
  console.error("Set GROQ_API_KEY or OPENAI_API_KEY (must be a Groq-compatible key when using GROQ_BASE_URL).");
  process.exit(1);
}

const provider = new OpenAIProvider({
  apiKey,
  baseUrl: process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1"
});

const MODEL = process.env.GROQ_MODEL_GAP_FILL ?? "llama-3.3-70b-versatile";

const SYSTEM = `You are a catalog schema architect. Given a product category path, produce a JSON Schema 2019-09 document that captures the attributes a typical product in that category needs.

Requirements:
- Output ONLY a valid JSON Schema object. No prose.
- Include type: "object".
- Include "required": [...] listing attributes that EVERY product in this category MUST have (be conservative — only truly mandatory fields).
- Include "properties" with type + units + enum/range constraints per attribute.
- Use lowercase snake_case for attribute keys.
- Include "additionalProperties": true.
- Include "tier": "authoritative" if the category is on the authoritative list passed in, otherwise "inferred".
- Numeric attributes with units should have suffix _<unit> in their key (e.g. screen_size_inches, packed_weight_grams, ram_gb, battery_mah, canopy_diameter_cm).
- For enums, prefer broadly-accepted values (e.g. season_rating: ["3-season", "4-season"]).
- Include a "$schema" of "https://json-schema.org/draft/2019-09/schema".
- Include a "$id" of form: "category_schemas/<path with slashes replaced by underscores>/v1".`;

function buildPrompt(path: string, isAuthoritative: boolean): string {
  return `Category path: ${path}
Tier: ${isAuthoritative ? "authoritative" : "inferred"}

Produce the JSON Schema now.`;
}

const lines = readFileSync(TAXONOMY_FILE, "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"));

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length) : null;
const targets = only ? [only] : lines;

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

let drafted = 0;
let skipped = 0;
let failed = 0;

for (const path of targets) {
  const safeName = path.replace(/\//g, "__");
  const outFile = join(OUT_DIR, `${safeName}.json`);
  if (existsSync(outFile)) {
    skipped++;
    continue;
  }

  const isAuthoritative = AUTHORITATIVE_LIST.includes(path);
  // eslint-disable-next-line no-console
  console.log(`Drafting ${path} (tier=${isAuthoritative ? "authoritative" : "inferred"})...`);

  try {
    const response = await provider.chatCompletion({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: buildPrompt(path, isAuthoritative) }
      ],
      maxTokens: 1500,
      temperature: 0.2,
      jsonMode: true
    });

    const schemaDoc = JSON.parse(response.content);
    writeFileSync(outFile, JSON.stringify(schemaDoc, null, 2) + "\n");
    drafted++;
  } catch (err) {
    failed++;
    // eslint-disable-next-line no-console
    console.error(`FAILED ${path}: ${err instanceof Error ? err.message : err}`);
  }
}

// eslint-disable-next-line no-console
console.log(JSON.stringify({ drafted, skipped, failed }, null, 2));
process.exit(failed > 0 ? 1 : 0);
