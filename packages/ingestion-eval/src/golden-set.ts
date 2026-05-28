// packages/ingestion-eval/src/golden-set.ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GoldenProduct } from "./types.js";

function validate(obj: unknown, file: string): GoldenProduct | string {
  const o = obj as Record<string, unknown>;
  for (const k of ["id", "sourceUrl", "archetype", "split", "rawHtmlPath", "labels"]) {
    if (o?.[k] === undefined) return `${file}: missing "${k}"`;
  }
  if (o.split !== "regression" && o.split !== "holdout") return `${file}: bad split "${String(o.split)}"`;
  return o as unknown as GoldenProduct;
}

/** Load every *.json in `dir` (non-recursive). Returns valid products + a list
 *  of human-readable errors for malformed files (never throws on bad data). */
export async function loadGoldenSet(dir: string): Promise<{ products: GoldenProduct[]; errors: string[] }> {
  const products: GoldenProduct[] = [];
  const errors: string[] = [];
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await Bun.file(join(dir, name)).text());
      const r = validate(parsed, name);
      if (typeof r === "string") errors.push(r);
      else products.push(r);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { products, errors };
}

export function splitBy(products: GoldenProduct[]): { regression: GoldenProduct[]; holdout: GoldenProduct[] } {
  return {
    regression: products.filter((p) => p.split === "regression"),
    holdout: products.filter((p) => p.split === "holdout"),
  };
}
