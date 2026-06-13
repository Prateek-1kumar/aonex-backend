#!/usr/bin/env bun
/**
 * run-taxonomy-eval.ts — P0 Task 9 baseline.
 *
 * Loads the golden set + the seeded taxonomy (aliases, nodes, schemas) and
 * measures the BASELINE: a deterministic alias-only classifier (the Layer-1 we
 * have today) for classification, and the @aonex/taxonomy-validator for
 * attribute normalization/validation. P1's ML/LLM classifier is measured as
 * LIFT over this number.
 *
 *   DATABASE_URL=... bun scripts/eval/run-taxonomy-eval.ts
 */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { schema, createDb } from "@aonex/db";
import { normalizeText as norm } from "@aonex/lib-utils";
import { validateAttributes } from "@aonex/taxonomy-validator";
import { loadLeafSchemas, leafSchemaFor } from "@aonex/taxonomy-schema";
import { scoreClassification, aggregateClassification, type ClassRow } from "@aonex/ingestion-eval";
import { classify as classifyV2, buildIndex, classifyWithFallback, deterministicResolver } from "@aonex/taxonomy-classifier";

const GOLDEN = "packages/ingestion-eval/fixtures/golden-taxonomy/products.yaml";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";

function catVariants(sc: string): string[] {
  if (!sc) return [];
  const last = sc.split(/[>/]/).pop() ?? sc;
  const b = norm(sc);
  return [b, b.replace(/ /g, ""), norm(last), norm(last).replace(/ /g, "")].filter(Boolean);
}

/** Baseline classifier: alias lookup on source category, then title n-grams. Deepest wins. */
function classify(input: { title: string; sourceCategory?: string }, aliasMap: Map<string, string>): string | null {
  for (const cand of catVariants(input.sourceCategory ?? "")) {
    const hit = aliasMap.get(cand);
    if (hit) return hit;
  }
  const toks = norm(input.title).split(" ").filter(Boolean);
  let best: string | null = null;
  let bestLevel = -1;
  for (let i = 0; i < toks.length; i++) {
    for (const cand of [toks[i]!, toks.slice(i, i + 2).join(" "), toks.slice(i, i + 2).join("")]) {
      const hit = aliasMap.get(cand);
      if (hit) {
        const lv = hit.split("/").length;
        if (lv > bestLevel) { best = hit; bestLevel = lv; }
      }
    }
  }
  return best;
}

interface GoldenProduct { id: string; input: { title: string; brand?: string; sourceCategory?: string; attrs?: Record<string, unknown> }; gold: { node_id: string; attrs?: Record<string, unknown> } }

const { client: db, close } = createDb(databaseUrl);
try {
  const aliasMap = new Map((await db.select().from(schema.taxonomyAliases)).map((a) => [a.normalizedLabel, a.nodeId]));
  const nodes = await db.select().from(schema.taxonomyNodes);
  const parentOf = new Map(nodes.map((n) => [n.nodeId, n.parentId]));
  const exists = new Set(nodes.map((n) => n.nodeId));
  const cidx = buildIndex(nodes.filter((n) => n.isLeaf).map((n) => ({ nodeId: n.nodeId, displayName: n.displayName })), aliasMap);
  const ancestorsOf = (id: string): string[] => {
    const out: string[] = [];
    let p = parentOf.get(id);
    while (p) { out.push(p); p = parentOf.get(p); }
    return out;
  };

  const schemaIndex = await loadLeafSchemas(db);

  const golden = (yaml.load(readFileSync(GOLDEN, "utf8")) as { products: GoldenProduct[] }).products;
  const ABSTAIN = "ABSTAIN";
  const known = golden.filter((p) => p.gold.node_id !== ABSTAIN);
  const unknown = golden.filter((p) => p.gold.node_id === ABSTAIN);
  const badGold = known.filter((p) => !exists.has(p.gold.node_id)).map((p) => p.id);

  const classRows: ClassRow[] = [];
  const v2Rows: ClassRow[] = [];
  let attrProducts = 0, attrComplete = 0, attrViolations = 0, attrFields = 0;
  for (const p of known) {
    const predicted = classify(p.input, aliasMap);
    classRows.push({ ...scoreClassification(predicted, p.gold.node_id, ancestorsOf), predicted });
    const v2 = classifyV2(p.input, cidx);
    v2Rows.push({ ...scoreClassification(v2.nodeId, p.gold.node_id, ancestorsOf), predicted: v2.nodeId });
    const leaf = leafSchemaFor(schemaIndex, p.gold.node_id);
    const attrs = p.input.attrs ?? {};
    if (leaf && Object.keys(attrs).length > 0) {
      const r = validateAttributes(leaf, attrs);
      attrProducts++; attrComplete += r.completeness.score; attrViolations += r.violations; attrFields += Object.keys(attrs).length;
    }
  }
  // Out-of-taxonomy: the fallback must NOT force-fit a wrong leaf.
  const unkOut: Record<string, number> = { assign: 0, propose_node: 0, abstain: 0 };
  for (const p of unknown) {
    const fb = await classifyWithFallback(p.input, cidx, deterministicResolver);
    unkOut[fb.outcome] = (unkOut[fb.outcome] ?? 0) + 1;
  }
  const unkHandled = (unkOut.propose_node ?? 0) + (unkOut.abstain ?? 0);

  const agg = aggregateClassification(classRows);
  const agg2 = aggregateClassification(v2Rows);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  /* eslint-disable no-console */
  console.log("\n===== TAXONOMY EVAL =====");
  console.log(`in-taxonomy products:   ${known.length}${badGold.length ? `  (⚠ unknown gold nodes: ${badGold.join(", ")})` : ""}`);
  console.log(`-- classification (in-taxonomy top-1 / weighted) --`);
  console.log(`  baseline (alias):       ${pct(agg.top1)} / ${pct(agg.weighted)}`);
  console.log(`  classifier (alias+lex): ${pct(agg2.top1)} / ${pct(agg2.weighted)}`);
  console.log(`-- out-of-taxonomy handling (${unknown.length} products, dry-run resolver) --`);
  console.log(`  correctly NOT force-fit: ${unkHandled}/${unknown.length}  (propose_node ${unkOut.propose_node ?? 0}, abstain ${unkOut.abstain ?? 0}, mis-assigned ${unkOut.assign ?? 0})`);
  console.log(`-- attributes (in-taxonomy) --`);
  console.log(`  products ${attrProducts} (${attrFields} fields)  completeness ${attrProducts ? (attrComplete / attrProducts).toFixed(1) : "n/a"}/100  violations ${attrViolations}`);
  console.log("=========================\n");
  /* eslint-enable no-console */
} finally {
  await close();
}
