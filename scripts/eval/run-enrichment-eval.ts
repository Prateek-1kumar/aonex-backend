#!/usr/bin/env bun
/**
 * run-enrichment-eval.ts — P2: measure the LIFT from grounded, node-schema
 * enrichment.
 *
 * The baseline (run-taxonomy-eval.ts) validates each golden product's INPUT
 * attributes against its gold node's schema — the "before-enrichment" number.
 * This harness instead RUNS the @aonex/taxonomy-enrichment engine (catalog-RAG
 * few-shot -> schema-conditioned generation -> normalize -> grounding verify ->
 * calibrate) on each product and re-scores, so we can show before -> after
 * completeness plus a grounding/hallucination read.
 *
 * Classification is held fixed (we use gold.node_id) so this isolates enrichment
 * quality from classifier accuracy.
 *
 *   set -a; . ./.env; set +a
 *   bun scripts/eval/run-enrichment-eval.ts            # all in-taxonomy golden products
 *   bun scripts/eval/run-enrichment-eval.ts --limit 6  # quick smoke
 */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { schema, createDb } from "@aonex/db";
import { OpenAIProvider } from "@aonex/ingestion-llm-extractor";
import {
  enrichProduct,
  retrieveExamples,
  departmentOf,
  acceptedAttributes,
  type CatalogEntry,
  type EnrichField,
  type AttrDataType,
} from "@aonex/taxonomy-enrichment";

const GOLDEN = "packages/ingestion-eval/fixtures/golden-taxonomy/products.yaml";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";
const argNum = (flag: string, def: number): number => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const LIMIT = argNum("--limit", Infinity);
// Sequential by default: Groq's tokens-per-minute cap 429-storms at any fan-out;
// override with --conc N if you have headroom.
const CONCURRENCY = argNum("--conc", 1);
const MAX_TOKENS = argNum("--max-tokens", 1500); // enrichment JSON is small; 4000 wasted TPM.

const llmKey = process.env.GROQ_API_KEY ?? process.env.OPENAI_API_KEY;
if (!llmKey) {
  console.error("No GROQ_API_KEY / OPENAI_API_KEY set — enrichment needs a model. Aborting.");
  process.exit(1);
}
const provider = new OpenAIProvider({
  apiKey: llmKey,
  baseUrl: process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
});
const model = process.env.GROQ_MODEL_ENRICH ?? "llama-3.3-70b-versatile";

interface GoldenProduct {
  id: string;
  input: { title: string; brand?: string; sourceCategory?: string; attrs?: Record<string, unknown> };
  gold: { node_id: string; attrs?: Record<string, unknown> };
}

const NON_ATTR = new Set(["title", "category_path", "_meta", "images", "description", "description_long", "description_short"]);
const firstScoped = (v: unknown): unknown => {
  if (v == null || typeof v !== "object") return v ?? null;
  const ch = Object.values(v as Record<string, unknown>)[0];
  if (ch == null || typeof ch !== "object") return ch ?? null;
  return Object.values(ch as Record<string, unknown>)[0] ?? null;
};
const asText = (v: unknown): string => (Array.isArray(v) ? v.join(" > ") : v == null ? "" : String(v));
const mapType = (t: string | undefined): AttrDataType | undefined =>
  t === "number" || t === "boolean" || t === "array" ? t : t === "string" ? "string" : undefined;

/** Promise pool — bounded concurrency over an ordered list. */
async function mapPool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const { client: db, close } = createDb(databaseUrl);
try {
  // ── Load the per-leaf enrichment schema (node_attributes ⨝ attribute_definitions). ──
  const adByKey = new Map((await db.select().from(schema.attributeDefinitions)).map((a) => [a.canonicalKey, a]));
  const schemaByNode = new Map<string, EnrichField[]>();
  const nodes = await db.select().from(schema.taxonomyNodes);
  const pathByNode = new Map(nodes.map((n) => [n.nodeId, n.displayPath]));
  for (const na of await db.select().from(schema.nodeAttributes)) {
    const ad = adByKey.get(na.canonicalKey);
    const f: EnrichField = { key: na.canonicalKey, tier: na.tier as EnrichField["tier"] };
    if (ad?.label) f.label = ad.label;
    if (ad?.description) f.description = ad.description;
    const dt = mapType(ad?.dataType);
    if (dt) f.dataType = dt;
    if (ad?.enumValues?.length) f.enumValues = ad.enumValues;
    if (ad?.canonicalUnit) { f.unit = ad.canonicalUnit; if (ad.allowedUnits?.length) f.allowedUnits = ad.allowedUnits; }
    if (na.isVariantAxis) f.isVariantAxis = true;
    (schemaByNode.get(na.nodeId) ?? schemaByNode.set(na.nodeId, []).get(na.nodeId)!).push(f);
  }

  // ── Build the catalog-RAG corpus from real catalog_products. ──
  const corpus: CatalogEntry[] = [];
  for (const p of await db.select().from(schema.catalogProducts)) {
    const wv = (p.winningValues ?? {}) as Record<string, unknown>;
    const identity = (p.identity ?? {}) as Record<string, unknown>;
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(wv)) if (!NON_ATTR.has(k)) { const s = firstScoped(v); if (s != null && s !== "") attrs[k] = s; }
    const title = asText(firstScoped(wv.title));
    if (!title) continue;
    corpus.push({
      title,
      ...(identity.brand ? { brand: String(identity.brand) } : {}),
      ...(p.categoryNodeId ? { nodeId: p.categoryNodeId } : {}),
      ...(p.categoryNodeId ? { departmentId: departmentOf(p.categoryNodeId) } : {}),
      attrs,
    });
  }

  // ── Golden set (in-taxonomy only — enrichment runs on a known leaf). ──
  const golden = (yaml.load(readFileSync(GOLDEN, "utf8")) as { products: GoldenProduct[] }).products;
  const known = golden
    .filter((p) => p.gold.node_id !== "ABSTAIN" && schemaByNode.has(p.gold.node_id))
    .slice(0, LIMIT);
  const skipped = golden.filter((p) => p.gold.node_id !== "ABSTAIN" && !schemaByNode.has(p.gold.node_id)).map((p) => p.id);

  /* eslint-disable no-console */
  console.log(`\n===== ENRICHMENT EVAL (P2) — model=${model}, ${known.length} products, RAG corpus=${corpus.length} =====`);
  if (skipped.length) console.log(`  (skipped — no node schema: ${skipped.join(", ")})`);

  const rows = await mapPool(known, CONCURRENCY, async (p) => {
    const nodeId = p.gold.node_id;
    const fields = schemaByNode.get(nodeId)!;
    const examples = retrieveExamples({ title: p.input.title, brand: p.input.brand, nodeId }, corpus, { k: 3 });
    const result = await enrichProduct(
      {
        nodeId,
        nodePath: pathByNode.get(nodeId) ?? nodeId,
        schema: fields,
        product: {
          title: p.input.title,
          ...(p.input.brand ? { brand: p.input.brand } : {}),
          ...(p.input.sourceCategory ? { sourceCategory: p.input.sourceCategory } : {}),
          knownAttrs: p.input.attrs ?? {},
        },
        examples,
      },
      { provider, model, maxTokens: MAX_TOKENS }
    );

    // Correctness vs gold.attrs where provided (case-insensitive normalized values).
    const goldAttrs = p.gold.attrs ?? {};
    const accepted = acceptedAttributes(result);
    let goldHits = 0, goldTotal = 0;
    for (const [k, v] of Object.entries(goldAttrs)) {
      goldTotal++;
      if (String(accepted[k] ?? "").toLowerCase() === String(v).toLowerCase()) goldHits++;
    }

    // Stream each product line as it finishes so progress is visible live.
    const before = result.completenessBefore.score.toFixed(0).padStart(3);
    const after = result.completenessAfter.score.toFixed(0).padStart(3);
    const proposed = result.completenessProposed.score.toFixed(0).padStart(3);
    const flag = result.error ? " ⚠ERR" : "";
    process.stdout.write(
      `  ${p.id} ${p.input.title.slice(0, 32).padEnd(33)} ${before} -> ${after} (→${proposed})  ` +
      `+${Object.keys(accepted).length}f (rag ${examples.length}, grnd ${(result.groundingRate * 100).toFixed(0)}%, +inf ${result.proposedInferred})${flag}\n`
    );
    return { p, result, examples: examples.length, accepted: Object.keys(accepted).length, goldHits, goldTotal };
  });

  // ── Aggregate ──
  let beforeSum = 0, afterSum = 0, proposedSum = 0, groundSum = 0, proposedInfer = 0, acceptedTotal = 0, violations = 0, errors = 0;
  let goldHitsAll = 0, goldTotalAll = 0;
  for (const r of rows) {
    beforeSum += r.result.completenessBefore.score;
    afterSum += r.result.completenessAfter.score;
    proposedSum += r.result.completenessProposed.score;
    groundSum += r.result.groundingRate;
    proposedInfer += r.result.proposedInferred;
    acceptedTotal += r.accepted;
    violations += r.result.fields.filter((f) => f.status === "invalid").length;
    if (r.result.error) errors++;
    goldHitsAll += r.goldHits; goldTotalAll += r.goldTotal;
  }

  const n = rows.length || 1;
  const pct = (x: number) => (x * 100).toFixed(1);
  console.log(`\n  -- completeness vs node schema (0..100) --`);
  console.log(`     before  (input attrs):        ${(beforeSum / n).toFixed(1)}`);
  console.log(`     after   (grounded, auto-apply): ${(afterSum / n).toFixed(1)}   (lift +${((afterSum - beforeSum) / n).toFixed(1)})`);
  console.log(`     proposed(+inferred, pending review): ${(proposedSum / n).toFixed(1)}   (ceiling if confirmed, +${((proposedSum - afterSum) / n).toFixed(1)})`);
  console.log(`  -- enrichment quality --`);
  console.log(`     auto-applied fields/product:  ${(acceptedTotal / n).toFixed(1)}  (all source-grounded)`);
  console.log(`     grounding rate (auto-applied):${pct(groundSum / n)}%`);
  console.log(`     inferred proposals (review):  ${proposedInfer} total  ·  schema violations flagged: ${violations}  ·  model errors: ${errors}`);
  if (goldTotalAll) console.log(`     gold-attr correctness:        ${goldHitsAll}/${goldTotalAll} expected values matched`);
  console.log("=========================================================\n");
  /* eslint-enable no-console */
} finally {
  await close();
}
