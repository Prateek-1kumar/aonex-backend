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
 * Enrichment runs on gold.node_id (so enrichment quality is isolated from the
 * classifier), but we ALSO classify each product for a categorization
 * precision/recall headline, and with --persist we write one enrichment_eval_runs
 * row (+ per-SKU rows) so the Catalog Quality Report can show the numbers + a
 * regression count vs the previous run.
 *
 *   set -a; . ./.env; set +a
 *   bun scripts/eval/run-enrichment-eval.ts                      # all in-taxonomy golden products
 *   bun scripts/eval/run-enrichment-eval.ts --limit 6           # quick smoke
 *   bun scripts/eval/run-enrichment-eval.ts --persist --label X # persist a run for the quality report
 */
import { createDb, schema } from "@aonex/db";
import { OpenAIProvider } from "@aonex/ingestion-llm-extractor";
import { selectEnrichProvider } from "@aonex/lib-utils";
import { loadGoldenProducts, type GoldenYamlProduct } from "./load-golden-yaml.js";
import {
  enrichProduct,
  retrieveExamples,
  acceptedAttributes,
} from "@aonex/taxonomy-enrichment";
import { loadLeafSchemas, loadRagCorpus } from "@aonex/taxonomy-schema";
import { classify, buildIndex } from "@aonex/taxonomy-classifier";
import { scoreClassification, precisionRecall, aggregateClassification, type ClassRow } from "@aonex/ingestion-eval";

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
const PERSIST = process.argv.includes("--persist");
const argStr = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const LABEL = argStr("--label") ?? null;

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

  // Classifier index (alias + lexical) for the categorization precision/recall
  // headline — same wiring as run-taxonomy-eval. Enrichment still runs on the gold
  // node; this only measures "would the classifier have picked the right leaf?".
  const aliasMap = new Map((await db.select().from(schema.taxonomyAliases)).map((a) => [a.normalizedLabel, a.nodeId]));
  const nodes = await db.select().from(schema.taxonomyNodes);
  const parentOf = new Map(nodes.map((node) => [node.nodeId, node.parentId]));
  const ancestorsOf = (id: string): string[] => {
    const out: string[] = [];
    let p = parentOf.get(id);
    while (p) { out.push(p); p = parentOf.get(p); }
    return out;
  };
  const cidx = buildIndex(nodes.filter((node) => node.isLeaf).map((node) => ({ nodeId: node.nodeId, displayName: node.displayName })), aliasMap);

  // ── Golden set (in-taxonomy only — enrichment runs on a known leaf). ──
  const golden: GoldenYamlProduct[] = loadGoldenProducts();
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
      {
        provider,
        model,
        maxTokens: MAX_TOKENS,
        ...(process.env.ENRICH_CONSISTENCY_PASS ? { consistency: { provider, model } } : {}),
      }
    );

    // Categorization: what WOULD the classifier have picked? (scored vs gold node)
    const predicted = classify(
      { title: p.input.title, ...(p.input.sourceCategory ? { sourceCategory: p.input.sourceCategory } : {}) },
      cidx
    ).nodeId;
    const cls = scoreClassification(predicted, nodeId, ancestorsOf);

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
    return { p, result, examples: examples.length, accepted: Object.keys(accepted).length, goldHits, goldTotal, predicted, classExact: cls.exact, classCredit: cls.credit };
  });

  // ── Aggregate ──
  let beforeSum = 0, afterSum = 0, proposedSum = 0, groundSum = 0, proposedInfer = 0, unverified = 0, acceptedTotal = 0, violations = 0, errors = 0;
  let goldHitsAll = 0, goldTotalAll = 0;
  let contentBeforeSum = 0, contentProposedSum = 0, contentGroundSum = 0, contentFieldsTotal = 0;
  for (const r of rows) {
    beforeSum += r.result.completenessBefore.score;
    afterSum += r.result.completenessAfter.score;
    proposedSum += r.result.completenessProposed.score;
    groundSum += r.result.groundingRate;
    proposedInfer += r.result.proposedInferred;
    unverified += r.result.unverifiedCount;
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
  console.log(`     unverified (suppressed):      ${unverified} total  (unanchored values, neither applied nor surfaced)`);
  if (goldTotalAll) console.log(`     gold-attr correctness:        ${goldHitsAll}/${goldTotalAll} expected values matched`);

  // ── Categorization (classifier vs gold) ──
  const classRows: ClassRow[] = rows.map((r) => ({ exact: r.classExact, credit: r.classCredit, predicted: r.predicted }));
  const pr = precisionRecall(classRows);
  const top1 = aggregateClassification(classRows).top1;
  console.log(`  -- categorization (classifier vs gold) --`);
  console.log(`     precision ${pct(pr.precision)}%  ·  recall ${pct(pr.recall)}%  ·  top-1 ${pct(top1)}%  (${pr.correct}/${pr.total})`);
  console.log("=========================================================\n");
  /* eslint-enable no-console */

  // ── Persist this run (for the Catalog Quality Report + regression count) ──
  if (PERSIST) {
    const goldAttrAccuracy = goldTotalAll ? goldHitsAll / goldTotalAll : null;
    const [runRow] = await db
      .insert(schema.enrichmentEvalRuns)
      .values({
        runLabel: LABEL,
        model,
        nProducts: rows.length,
        categorizationPrecision: pr.precision,
        categorizationRecall: pr.recall,
        categorizationTop1: top1,
        groundingRate: groundSum / n,
        completenessBefore: beforeSum / n,
        completenessAfter: afterSum / n,
        completenessLift: (afterSum - beforeSum) / n,
        goldAttrAccuracy,
        contentGroundingRate: contentGroundSum / n,
      })
      .returning({ runId: schema.enrichmentEvalRuns.runId });
    const runId = runRow!.runId;
    await db.insert(schema.enrichmentEvalRunSkus).values(
      rows.map((r) => ({
        runId,
        goldenId: r.p.id,
        nodeId: r.p.gold.node_id,
        predictedNodeId: r.predicted,
        categorizationCorrect: r.classExact,
        completenessAfter: r.result.completenessAfter.score,
        groundingRate: r.result.groundingRate,
        goldAttrHits: r.goldHits,
        goldAttrTotal: r.goldTotal,
        fields: r.result.fields.map((f) => ({ key: f.key, grounding: f.grounding, accepted: f.accepted })),
      }))
    );
    /* eslint-disable-next-line no-console */
    console.log(`  ✓ persisted eval run ${runId}${LABEL ? ` ("${LABEL}")` : ""} — ${rows.length} SKUs\n`);
  }
} finally {
  await close();
}
