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
import { validateAttributes, type AttributeSpec } from "@aonex/taxonomy-validator";
import { scoreClassification, aggregateClassification, type ClassRow } from "@aonex/ingestion-eval";
import { classify as classifyV2, buildIndex } from "@aonex/taxonomy-classifier";

const GOLDEN = "packages/ingestion-eval/fixtures/golden-taxonomy/products.yaml";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";

const norm = (s: string) =>
  s.toLowerCase().replace(/&/g, " and ").replace(/'/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

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

  const adByKey = new Map((await db.select().from(schema.attributeDefinitions)).map((a) => [a.canonicalKey, a]));
  const schemaByNode = new Map<string, AttributeSpec[]>();
  for (const na of await db.select().from(schema.nodeAttributes)) {
    const ad = adByKey.get(na.canonicalKey);
    const spec: AttributeSpec = { key: na.canonicalKey, tier: na.tier as AttributeSpec["tier"] };
    if (ad?.enumValues?.length) spec.enumValues = ad.enumValues;
    if (ad?.canonicalUnit) { spec.unit = ad.canonicalUnit; spec.dataType = "number"; if (ad.allowedUnits?.length) spec.allowedUnits = ad.allowedUnits; }
    (schemaByNode.get(na.nodeId) ?? schemaByNode.set(na.nodeId, []).get(na.nodeId)!).push(spec);
  }

  const golden = (yaml.load(readFileSync(GOLDEN, "utf8")) as { products: GoldenProduct[] }).products;
  const badGold = golden.filter((p) => !exists.has(p.gold.node_id)).map((p) => p.id);

  const classRows: ClassRow[] = [];
  const v2Rows: ClassRow[] = [];
  let attrProducts = 0, attrComplete = 0, attrViolations = 0, attrFields = 0;
  for (const p of golden) {
    const predicted = classify(p.input, aliasMap);
    classRows.push({ ...scoreClassification(predicted, p.gold.node_id, ancestorsOf), predicted });
    const v2 = classifyV2(p.input, cidx);
    v2Rows.push({ ...scoreClassification(v2.nodeId, p.gold.node_id, ancestorsOf), predicted: v2.nodeId });
    const sch = schemaByNode.get(p.gold.node_id);
    const attrs = p.input.attrs ?? {};
    if (sch && Object.keys(attrs).length > 0) {
      const r = validateAttributes({ nodeId: p.gold.node_id, attributes: sch }, attrs);
      attrProducts++; attrComplete += r.completeness.score; attrViolations += r.violations; attrFields += Object.keys(attrs).length;
    }
  }

  const agg = aggregateClassification(classRows);
  const agg2 = aggregateClassification(v2Rows);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  /* eslint-disable no-console */
  console.log("\n===== TAXONOMY EVAL =====");
  console.log(`golden products:        ${golden.length}${badGold.length ? `  (⚠ unknown gold nodes: ${badGold.join(", ")})` : ""}`);
  console.log(`-- baseline (alias-only) --`);
  console.log(`  top-1:    ${pct(agg.top1)}   weighted: ${pct(agg.weighted)}   abstain: ${pct(agg.abstained)}`);
  console.log(`-- classifier core (alias + lexical) --`);
  console.log(`  top-1:    ${pct(agg2.top1)}   weighted: ${pct(agg2.weighted)}   abstain: ${pct(agg2.abstained)}`);
  console.log(`attribute products:     ${attrProducts}  (${attrFields} provided fields)`);
  console.log(`attr completeness avg:  ${attrProducts ? (attrComplete / attrProducts).toFixed(1) : "n/a"} / 100`);
  console.log(`attr violations:        ${attrViolations}`);
  console.log("=====================================================\n");
  /* eslint-enable no-console */
} finally {
  await close();
}
