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
import { createDb } from "@aonex/db";
import { OpenAIProvider } from "@aonex/ingestion-llm-extractor";
import { selectEnrichProvider } from "@aonex/lib-utils";
import {
  enrichProduct,
  retrieveExamples,
  acceptedAttributes,
} from "@aonex/taxonomy-enrichment";
import { loadLeafSchemas, loadRagCorpus } from "@aonex/taxonomy-schema";

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

// Provider precedence: DeepSeek → Groq → OpenAI (shared with the worker).
const selected = selectEnrichProvider(process.env);
if (!selected) {
  console.error("No DEEPSEEK_API_KEY / GROQ_API_KEY / OPENAI_API_KEY set — enrichment needs a model. Aborting.");
  process.exit(1);
}
const provider = new OpenAIProvider({
  apiKey: selected.apiKey,
  baseUrl: selected.baseUrl,
  fallbackModels: selected.fallbackModels,
});
const model = selected.model;

interface GoldenProduct {
  id: string;
  input: { title: string; brand?: string; sourceCategory?: string; attrs?: Record<string, unknown> };
  gold: { node_id: string; attrs?: Record<string, unknown> };
}

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
  // Per-leaf enrichment schema + catalog-RAG corpus via the canonical loaders
  // (@aonex/taxonomy-schema) — the same wiring the worker enrichment job uses.
  const { schemaByNode, pathByNode } = await loadLeafSchemas(db);
  const corpus = await loadRagCorpus(db);

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
    const examples = retrieveExamples(
      { title: p.input.title, ...(p.input.brand ? { brand: p.input.brand } : {}), nodeId },
      corpus,
      { k: 3 }
    );
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
    const content = result.contentQualityProposed.score.toFixed(0).padStart(3);
    const contentFields = result.fields.filter((f) => f.kind === "content" && f.proposable).length;
    process.stdout.write(
      `  ${p.id} ${p.input.title.slice(0, 32).padEnd(33)} spec ${before}->${after}(→${proposed})  ` +
      `content →${content} (${contentFields} copy fields, grnd ${(result.contentGroundingRate * 100).toFixed(0)}%)  ` +
      `+${Object.keys(accepted).length}spec${flag}\n`
    );
    return { p, result, examples: examples.length, accepted: Object.keys(accepted).length, goldHits, goldTotal };
  });

  // ── Aggregate ──
  let beforeSum = 0, afterSum = 0, proposedSum = 0, groundSum = 0, proposedInfer = 0, acceptedTotal = 0, violations = 0, errors = 0;
  let goldHitsAll = 0, goldTotalAll = 0;
  let contentBeforeSum = 0, contentProposedSum = 0, contentGroundSum = 0, contentFieldsTotal = 0;
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
    contentBeforeSum += r.result.contentQualityBefore.score;
    contentProposedSum += r.result.contentQualityProposed.score;
    contentGroundSum += r.result.contentGroundingRate;
    contentFieldsTotal += r.result.fields.filter((f) => f.kind === "content" && f.proposable).length;
  }

  const n = rows.length || 1;
  const pct = (x: number) => (x * 100).toFixed(1);
  console.log(`\n  -- completeness vs node schema (0..100) --`);
  console.log(`     before  (input attrs):        ${(beforeSum / n).toFixed(1)}`);
  console.log(`     after   (grounded, auto-apply): ${(afterSum / n).toFixed(1)}   (lift +${((afterSum - beforeSum) / n).toFixed(1)})`);
  console.log(`     proposed(+inferred, pending review): ${(proposedSum / n).toFixed(1)}   (ceiling if confirmed, +${((proposedSum - afterSum) / n).toFixed(1)})`);
  console.log(`  -- content quality (description / SEO / marketing / AEO, 0..100) --`);
  console.log(`     before  (existing content):   ${(contentBeforeSum / n).toFixed(1)}`);
  console.log(`     proposed(synthesized, review): ${(contentProposedSum / n).toFixed(1)}   (lift +${((contentProposedSum - contentBeforeSum) / n).toFixed(1)})`);
  console.log(`     content fields/product:       ${(contentFieldsTotal / n).toFixed(1)}  ·  compositional grounding ${pct(contentGroundSum / n)}%`);
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
