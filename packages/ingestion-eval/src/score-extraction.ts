// packages/ingestion-eval/src/score-extraction.ts
import type { GoldenProduct, ScoredField, EvalReport } from "./types.js";
import { fieldWeight } from "./field-weights.js";
import { fieldsMatch } from "./normalize.js";

/** Score one product's extracted fields against its golden labels. Only fields
 *  present in `labels` are scored (the golden set defines the expectation). */
export function scoreProduct(
  golden: GoldenProduct,
  extracted: Record<string, string | number | null>,
  rawConfidence: Record<string, number> = {}
): ScoredField[] {
  return Object.entries(golden.labels).map(([field, expected]) => {
    const got = (field in extracted ? extracted[field] : null) ?? null;
    const sf: ScoredField = {
      field,
      expected,
      extracted: got,
      correct: fieldsMatch(field, expected, got),
      weight: fieldWeight(field),
    };
    if (field in rawConfidence) {
      const c = rawConfidence[field];
      if (c !== undefined) sf.rawConfidence = c;
    }
    return sf;
  });
}

/** Aggregate weighted precision/recall across many products.
 *  Recall = correct weight / expected weight (over golden-labelled fields).
 *  Precision = correct weight / attempted weight (fields the extractor produced). */
export function aggregate(perProduct: ScoredField[][]): EvalReport {
  let correctW = 0, expectedW = 0, attemptedW = 0;
  const perField: Record<string, { correctW: number; expectedW: number; attemptedW: number; n: number }> = {};
  for (const scored of perProduct) {
    for (const s of scored) {
      const pf = (perField[s.field] ??= { correctW: 0, expectedW: 0, attemptedW: 0, n: 0 });
      pf.n++;
      pf.expectedW += s.weight; expectedW += s.weight;
      if (s.extracted !== null) { pf.attemptedW += s.weight; attemptedW += s.weight; }
      if (s.correct) { pf.correctW += s.weight; correctW += s.weight; }
    }
  }
  const div = (a: number, b: number) => (b === 0 ? 0 : a / b);
  return {
    weightedRecall: div(correctW, expectedW),
    weightedPrecision: div(correctW, attemptedW),
    perField: Object.fromEntries(
      Object.entries(perField).map(([f, v]) => [f, {
        precision: div(v.correctW, v.attemptedW), recall: div(v.correctW, v.expectedW), n: v.n,
      }])
    ),
    count: perProduct.length,
  };
}
