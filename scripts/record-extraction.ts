/**
 * Records what the structured extractor produces for each *.html fixture in
 * packages/ingestion-eval/fixtures/golden/, writing a sibling *.extracted.json
 * file that the eval CLI scores against the golden labels.
 *
 * This script is committed (so the recording is reproducible) and so are the
 * resulting *.extracted.json files (so the eval is deterministic and offline).
 * Re-run whenever the extractor changes shape: `bun run scripts/record-extraction.ts`.
 *
 * Scope is intentionally narrow for Phase 0: we only run cleanHtml +
 * parseJsonLd, because that is the path the Tasks 1-3 fix exercises
 * (@graph unwrapping + array @type Product). Microdata / opengraph / etc.
 * land in later phases.
 */
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { cleanHtml } from "@aonex/ingestion-link-fetcher";
// parseJsonLd is the only parser we need for Phase 0 — the structured package's
// public entry only exports `extractStructured` (which runs every parser). A
// relative import keeps the script self-contained without expanding the public
// API of @aonex/ingestion-structured for a one-off recording tool.
import { parseJsonLd } from "../packages/ingestion/structured/src/parsers/json-ld.js";
import { loadGoldenSet } from "@aonex/ingestion-eval";

const FIXTURES_DIR = join(
  import.meta.dir,
  "..",
  "packages",
  "ingestion-eval",
  "fixtures",
  "golden",
);

async function main(): Promise<void> {
  const { products, errors } = await loadGoldenSet(FIXTURES_DIR);
  if (errors.length > 0) {
    for (const e of errors) console.error(`fixture error: ${e}`);
  }
  const byId = new Map(products.map((p) => [p.id, p]));

  const entries = await readdir(FIXTURES_DIR);
  const htmlFiles = entries.filter((n) => n.endsWith(".html"));
  if (htmlFiles.length === 0) {
    console.log("no *.html fixtures found; nothing to record");
    return;
  }

  let recorded = 0;
  let skipped = 0;
  for (const htmlName of htmlFiles) {
    const id = basename(htmlName, ".html");
    const golden = byId.get(id);
    if (!golden) {
      console.warn(`skip ${htmlName}: no matching golden JSON for id="${id}"`);
      skipped++;
      continue;
    }

    const htmlPath = join(FIXTURES_DIR, htmlName);
    const rawHtml = await Bun.file(htmlPath).text();
    const { structuredBlocks } = cleanHtml(rawHtml);
    const parsed = parseJsonLd(structuredBlocks.jsonLd, {
      pageUrl: golden.sourceUrl,
    });

    // Flatten the facts into a plain rawKey -> value record. Coerce numeric
    // strings for known price fields so the JSON contract uses real numbers
    // (the eval's normalizer compares prices numerically with 1% tolerance).
    const PRICE_KEYS = new Set(["base_price", "price"]);
    const flat: Record<string, string | number | null> = {};
    for (const f of parsed.facts) {
      const v = f.extractedValue;
      let coerced: string | number | null;
      if (v == null) {
        coerced = null;
      } else if (typeof v === "number") {
        coerced = v;
      } else if (typeof v === "string") {
        if (PRICE_KEYS.has(f.rawKey)) {
          const n = Number(v);
          coerced = Number.isFinite(n) ? n : v;
        } else {
          coerced = v;
        }
      } else {
        // Non-scalar (arrays, objects like images[]) — stringify so the
        // recording stays JSON-clean but is not scored on directly.
        coerced = JSON.stringify(v);
      }
      flat[f.rawKey] = coerced;
    }

    const outPath = join(FIXTURES_DIR, `${id}.extracted.json`);
    await Bun.write(outPath, `${JSON.stringify(flat, null, 2)}\n`);
    console.log(`recorded ${htmlName} -> ${id}.extracted.json (${parsed.facts.length} facts)`);
    recorded++;
  }

  console.log(`done: ${recorded} recorded, ${skipped} skipped`);
}

await main();
