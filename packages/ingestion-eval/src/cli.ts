import type { Decision, GoldenProduct } from "./types.js";
import { evaluateGate } from "./gate.js";

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

  const code = await runEval({
    products,
    loadExtracted,
    decisionsOverride: decisions,
    regressionPrecision,
    holdoutPrecision,
  });
  process.exit(code);
}
