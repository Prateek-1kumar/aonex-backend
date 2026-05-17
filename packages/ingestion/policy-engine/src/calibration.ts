// packages/ingestion/policy-engine/src/calibration.ts
//
// Spec §14.3 — apply a fitted isotonic calibration model to each fact's raw
// confidence BEFORE the router runs. Faithful to the philosophy:
//   raw confidence → empirical accuracy via per-(extractor × category × source-type)
//   isotonic regression, fit nightly by the calibration-refit cron.
//
// When no calibration model exists for the (extractor × category × source-type)
// tuple, the fact's confidence is left unchanged (graceful degradation).

import type { ExtractedFact } from "@aonex/ingestion-field-extractor";
import { applyIsotonic, type IsotonicModel } from "@aonex/calibration";

export interface CalibrationKey {
  extractor: string;
  category: string | null;
  sourceType: string;
}

/** Caller-supplied lookup. Implementations can wrap a DB store, an in-memory cache, or a stub. */
export type CalibrationLookup = (key: CalibrationKey) => IsotonicModel | null;

export interface CalibrationContext {
  /** extractor_version of the run that produced these facts (e.g. "llm-url@1.0"). */
  extractor: string;
  /** canonical category of the product the facts belong to (null when unknown). */
  category: string | null;
  /** "link_url" | "templated_csv" | "marketplace_connector". */
  sourceType: string;
}

/**
 * Return a new ExtractedFact[] with confidences replaced by the calibrated
 * value when a model exists, or the raw value when not.
 *
 * The input array is NOT mutated; each fact is shallow-copied with a new
 * `confidence` field.
 */
export function calibrateFacts(
  facts: ReadonlyArray<ExtractedFact>,
  context: CalibrationContext,
  lookup: CalibrationLookup
): ExtractedFact[] {
  const model = lookup({
    extractor: context.extractor,
    category: context.category,
    sourceType: context.sourceType
  });
  if (!model) {
    // Defensive copy so callers can't accidentally rely on identity for cache invalidation.
    return facts.map((f) => ({ ...f }));
  }
  return facts.map((f) => ({
    ...f,
    confidence: applyIsotonic(model, f.confidence)
  }));
}

/**
 * Default no-op lookup: always returns null. Used until storage is wired
 * (Phase 8.1 follow-up). With this lookup, calibrateFacts is an identity
 * pass + shallow-copy.
 */
export const noopCalibrationLookup: CalibrationLookup = () => null;
