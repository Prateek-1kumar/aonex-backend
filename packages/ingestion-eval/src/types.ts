// packages/ingestion-eval/src/types.ts

/** A single product in the labeled golden set. Deterministic: stores recorded
 *  input (raw HTML), never a live URL fetch. */
export interface GoldenProduct {
  id: string;
  sourceUrl: string;
  /** Archetype this product belongs to (drives expected fields later). */
  archetype: string;
  /** Which eval split this row belongs to. `holdout` is never tuned on. */
  split: "regression" | "holdout";
  /** Path (relative to package root) to the recorded raw HTML fixture. */
  rawHtmlPath: string;
  /** Ground-truth field values. Keys are canonical field names. */
  labels: Record<string, string | number>;
  /** Variant-defining attributes (storage/size/color/region) for dedup checks. */
  variantKeys?: Record<string, string>;
}

/** One product's pipeline decision, used to compute the north + guardrail metrics. */
export interface Decision {
  id: string;
  /** Did the pipeline auto-promote with no human touch? */
  autoPromoted: boolean;
  /** Did business-critical fields pass audit against the golden labels? */
  fieldsCorrect: boolean;
  /** Was the dedup/identity decision correct (no wrong merge / no missed merge)? */
  dedupCorrect: boolean;
}

/** Result of comparing one extracted field to its golden label. */
export interface ScoredField {
  field: string;
  expected: string | number;
  extracted: string | number | null;
  correct: boolean;
  weight: number;
  /** The extractor's raw confidence for this field, if known (for calibration). */
  rawConfidence?: number;
}

/** Aggregate report for a set of products. */
export interface EvalReport {
  weightedPrecision: number;
  weightedRecall: number;
  perField: Record<string, { precision: number; recall: number; n: number }>;
  count: number;
}
