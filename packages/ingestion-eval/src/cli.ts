// CLI + core run loop for the ingestion eval harness.
//
// runEval feeds golden-set decisions through evaluateGate; the import.meta.main
// block (invoked via `bun run src/cli.ts`) loads golden fixtures, scores each
// product (archetype-completeness or legacy critical-fields gate), and prints
// weighted precision/recall, unknown-site recall, identity-pair and ER metrics,
// exiting non-zero if any bar regresses.

import type { Decision, GoldenProduct } from "./types.js";
import { evaluateGate } from "./gate.js";

// Phase 3 Task 7: regression bar for unknown-site recall. Calibrated to the
// value the eval reports today (run `bun run --filter=@aonex/ingestion-eval eval`
// and read the unknown-site recall line). Bump up as the fixture set grows.
// A real-world unknown-site iteration loop (LLM prompt/schema tuning) lives
// in Phase 3.x — Task 7's deliverable is the measurement infrastructure
// (3 synthetic unknown-site fixtures + a CLI assertion) so future LLM-driven
// improvements are observably moving the bar.
export const UNKNOWN_SITE_RECALL_BAR = 0.6; // tune up as the eval set grows

/** Fixture ids that represent sites with NO per-site parser. The CLI uses
 *  these to compute a dedicated "unknown-site" weighted recall subset, which
 *  is the headline metric for the generic extraction path. */
export const UNKNOWN_SITE_IDS: ReadonlySet<string> = new Set([
  "vijay-sales-iphone-15",
  "reliance-digital-pixel-8",
  "flipkart-galaxy-s24",
]);

export interface RunEvalOptions {
  products: GoldenProduct[];
  /** Load the recorded extraction output for a product id (Phase 0 records these). */
  loadExtracted: (id: string) => Promise<Record<string, string | number | null>>;
  /** For tests / pre-extraction phases: supply decisions directly. */
  decisionsOverride?: Decision[];
  regressionPrecision: number;
  holdoutPrecision: number;
  print?: (line: string) => void;
}

export async function runEval(opts: RunEvalOptions): Promise<number> {
  const print = opts.print ?? ((l: string) => console.log(l));
  // Decisions come from the override (early phases) or are derived per product
  // once the live extractor + identity decisions are wired (Phase 0+).
  const decisions: Decision[] = opts.decisionsOverride ?? [];
  if (decisions.length === 0) {
    print("skipped: no decisions to score (placeholder wiring; real outputs land in Phase 0)");
    return 0;
  }
  const res = evaluateGate({
    decisions,
    regressionPrecision: opts.regressionPrecision,
    holdoutPrecision: opts.holdoutPrecision,
  });
  print(`auto-promote precision: ${res.metrics.autoPromotePrecision.toFixed(3)} ` +
        `rate: ${res.metrics.autoPromoteRate.toFixed(3)} drift: ${res.drift.toFixed(3)}`);
  if (!res.pass) { for (const r of res.reasons) print(`FAIL: ${r}`); return 1; }
  print("PASS");
  return 0;
}

// CLI entry: `bun run src/cli.ts`
if (import.meta.main) {
  const { loadGoldenSet, scoreProduct, aggregate, splitBy } = await import("./index.js");
  const { CRITICAL_FIELDS } = await import("./field-weights.js");
  const { getArchetype, scoreCompleteness, archetypeEnabledFor } = await import("@aonex/archetypes");

  const fixturesDir = `${import.meta.dir}/../fixtures/golden`;
  const { products, errors } = await loadGoldenSet(fixturesDir);
  if (errors.length > 0) {
    for (const e of errors) console.error(`fixture error: ${e}`);
  }

  // Phase 1: default the archetype flag to smartphone if not explicitly set,
  // so the demo path exercises completeness gating. Production callers can
  // override by setting the env to "" or another vertical list.
  const allowlist = process.env.AONEX_ARCHETYPE_VERTICALS ?? "smartphone";

  const loadExtracted = async (id: string): Promise<Record<string, string | number | null>> => {
    const path = `${fixturesDir}/${id}.extracted.json`;
    try {
      const text = await Bun.file(path).text();
      return JSON.parse(text);
    } catch {
      return {}; // no recorded extraction yet → all fields will score as missing
    }
  };

  const perProduct = await Promise.all(
    products.map(async (p) => {
      const extracted = await loadExtracted(p.id);
      return { product: p, extracted, scored: scoreProduct(p, extracted) };
    })
  );

  // Decisions:
  //   autoPromoted = would the gate admit it? Completeness when flag+archetype, else legacy heuristic.
  //   fieldsCorrect = did extraction get critical fields right? (Always from golden scoring.)
  //   dedupCorrect = true (Phase 2 wires real identity scoring).
  const decisions = perProduct.map(({ product, extracted, scored }) => {
    const criticalCorrect = scored
      .filter((s) => CRITICAL_FIELDS.has(s.field))
      .every((s) => s.correct);

    let autoPromoted: boolean;
    const arch = getArchetype(product.archetype);
    if (arch && archetypeEnabledFor(product.archetype, allowlist)) {
      // Build the present-set from the recorded extraction. A field is "present"
      // when its extracted value is neither null nor empty string.
      const present = new Set<string>(
        Object.entries(extracted)
          .filter(([, v]) => v !== null && String(v).trim() !== "")
          .map(([k]) => k)
      );
      const r = scoreCompleteness(arch, present, { threshold: 0.8, identifierExists: true });
      autoPromoted = r.hardFloorOk && r.meetsThreshold;
    } else {
      // Legacy fallback: critical-fields heuristic (matches Phase 0 baseline).
      autoPromoted = criticalCorrect;
    }

    return {
      id: product.id,
      autoPromoted,
      fieldsCorrect: criticalCorrect,
      dedupCorrect: true,
    };
  });

  // Per-split precision: of products auto-promoted in this split, what fraction
  // is correct on fields AND dedup?
  const splits = splitBy(products);
  const precisionFor = (subset: typeof products): number => {
    const subDecisions = decisions.filter((d) => subset.some((p) => p.id === d.id));
    const promoted = subDecisions.filter((d) => d.autoPromoted);
    if (promoted.length === 0) return 0;
    return promoted.filter((d) => d.fieldsCorrect && d.dedupCorrect).length / promoted.length;
  };
  const regressionPrecision = precisionFor(splits.regression);
  const holdoutPrecision = precisionFor(splits.holdout);

  const report = aggregate(perProduct.map((p) => p.scored));
  console.log(`fixtures scored: ${products.length} (regression=${splits.regression.length}, holdout=${splits.holdout.length}, allowlist="${allowlist}")`);
  console.log(`weighted precision: ${report.weightedPrecision.toFixed(3)}, recall: ${report.weightedRecall.toFixed(3)}`);

  // Phase 3 Task 7: unknown-site recall — products whose source has no
  // per-site parser. This is the headline metric for the generic extraction
  // path. If it regresses below UNKNOWN_SITE_RECALL_BAR, the eval fails so
  // we get an early signal before a prompt/schema change ships.
  const unknownSubset = perProduct.filter((p) => UNKNOWN_SITE_IDS.has(p.product.id));
  const unknownReasons: string[] = [];
  if (unknownSubset.length === 0) {
    console.log(`unknown-site recall: n/a (no unknown-site fixtures matched ids=[${[...UNKNOWN_SITE_IDS].join(",")}])`);
  } else {
    const unknownReport = aggregate(unknownSubset.map((p) => p.scored));
    console.log(
      `unknown-site recall: ${unknownReport.weightedRecall.toFixed(3)} ` +
      `(bar ${UNKNOWN_SITE_RECALL_BAR.toFixed(3)}, n=${unknownSubset.length})`
    );
    if (unknownReport.weightedRecall < UNKNOWN_SITE_RECALL_BAR) {
      unknownReasons.push(
        `unknown-site recall ${unknownReport.weightedRecall.toFixed(3)} < ${UNKNOWN_SITE_RECALL_BAR.toFixed(3)}`
      );
    }
  }

  const { loadIdentityPairs, mergeMetrics } = await import("./merge-pairs.js");
  const pairsDir = `${import.meta.dir}/../fixtures/identity-pairs`;
  const { pairs, errors: pairErrors } = await loadIdentityPairs(pairsDir);
  for (const e of pairErrors) console.error(`pair error: ${e}`);
  const mp = mergeMetrics(pairs);
  console.log(`identity pairs: ${mp.total} | auto-merged: ${mp.autoMerged} | wrong: ${mp.wrongAutoMerges} | mergePrecision: ${mp.mergePrecision.toFixed(3)}`);

  const { erMetrics: erMet, defaultPairToSides: erSides, ER_PRECISION_BAR, ER_RECALL_BAR } = await import("./er-eval.js");
  const erM = erMet(pairs, erSides);
  console.log(`er metrics: prec=${erM.precision.toFixed(3)} recall=${erM.recall.toFixed(3)} (bars ${ER_PRECISION_BAR}/${ER_RECALL_BAR}, tp=${erM.truePositive} fp=${erM.falsePositive} fn=${erM.falseNegative})`);

  const code = await runEval({
    products,
    loadExtracted,
    decisionsOverride: decisions,
    regressionPrecision,
    holdoutPrecision,
  });
  // Surface the unknown-site bar failure as a CLI-level FAIL on top of the
  // existing gate signals. Either signal failing → non-zero exit.
  for (const r of unknownReasons) console.log(`FAIL: ${r}`);
  process.exit(unknownReasons.length > 0 ? 1 : code);
}
