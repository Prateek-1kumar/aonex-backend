// Shared loader for the taxonomy/enrichment golden set.
//
// The set outgrew a single hand-edited products.yaml (unreviewable + merge-conflict
// prone at ~150 entries), so it now lives as one file per department under
// fixtures/golden-taxonomy/products/. This loader globs + flattens them, and still
// reads the legacy single products.yaml when present so older checkouts keep working.
// Duplicate ids across files are a loud error (a copy-paste mistake, not data).

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

/** One golden product: a (deliberately messy) input + the human-verified answer key. */
export interface GoldenYamlProduct {
  id: string;
  input: { title: string; brand?: string; sourceCategory?: string; attrs?: Record<string, unknown> };
  /** gold.node_id = correct canonical leaf (or "ABSTAIN"); gold.attrs = expected
   *  normalized attribute values, used to score attribute-extraction accuracy. */
  gold: { node_id: string; attrs?: Record<string, unknown> };
}

const GOLDEN_DIR = "packages/ingestion-eval/fixtures/golden-taxonomy/products";
const LEGACY_FILE = "packages/ingestion-eval/fixtures/golden-taxonomy/products.yaml";

/** Load every *.yaml under `dir` (each a `{ products: [...] }` doc) and flatten,
 *  plus the legacy single file if it still exists. Throws on duplicate ids. */
export function loadGoldenProducts(dir: string = GOLDEN_DIR, legacyFile: string = LEGACY_FILE): GoldenYamlProduct[] {
  const out: GoldenYamlProduct[] = [];
  const seen = new Set<string>();

  const ingest = (raw: string, src: string): void => {
    const doc = yaml.load(raw) as { products?: GoldenYamlProduct[] } | null;
    for (const p of doc?.products ?? []) {
      if (!p?.id) throw new Error(`golden ${src}: an entry is missing "id"`);
      if (seen.has(p.id)) throw new Error(`golden: duplicate id "${p.id}" (second seen in ${src})`);
      seen.add(p.id);
      out.push(p);
    }
  };

  if (existsSync(dir) && statSync(dir).isDirectory()) {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      ingest(readFileSync(join(dir, name), "utf8"), name);
    }
  }
  if (existsSync(legacyFile)) ingest(readFileSync(legacyFile, "utf8"), "products.yaml");

  return out;
}
