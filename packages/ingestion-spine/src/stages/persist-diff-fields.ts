import { schema, type DrizzleClient } from "@aonex/db";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

export interface PersistDiffFieldsInput {
  db: DrizzleClient;
  diffId: string;
  payload: Record<string, unknown>;
  facts: ReadonlyArray<ExtractedFact>;
}

/**
 * When the canonical payload has a field but no mapped fact provides
 * a confidence for it, we use 0.6 — high enough to display but well
 * below the 0.9 auto-approve threshold. Matches legacy link-catalog-pipeline.
 */
const FIELD_CONFIDENCE_FALLBACK = 0.6;

/**
 * The set of canonical fields the reviewer UI surfaces per-diff. Matches the
 * keys legacy persistProposedDiffFields() in link-catalog-pipeline.ts wrote
 * out. Anything outside this list is ignored (variant sub-facts, evidence
 * blobs, raw extractor metadata, etc.).
 */
const KNOWN_FIELD_KEYS = [
  "title",
  "brand",
  "gtin",
  "modelNumber",
  "description",
  "basePrice",
  "currency",
  "canonicalCategory",
  "images",
  "attributes",
  "variants"
] as const;

/**
 * Mirrors legacy `persistProposedDiffFields` in link-catalog-pipeline.ts —
 * one row per known canonical field for the reviewer UI's field-level
 * approve/reject. Confidence per field is the max confidence of any fact
 * pointing at that canonical path; missing facts fall back to 0.6.
 *
 * Idempotency note: the caller MUST only invoke this when the parent
 * proposed_diffs row was newly inserted (i.e. `runDiff` returned
 * `{ created: true }`) — otherwise we'd duplicate per-field rows on retry.
 */
export async function persistDiffFields(input: PersistDiffFieldsInput): Promise<void> {
  const factConfidence = new Map<string, number>();
  for (const fact of input.facts) {
    const key = fact.canonicalPath ?? fact.rawKey;
    factConfidence.set(key, Math.max(factConfidence.get(key) ?? 0, fact.confidence));
  }

  const rows: Array<{
    diffId: string;
    fieldName: string;
    newValue: unknown;
    confidence: string;
    isAutoApproved: boolean;
  }> = [];

  for (const fieldName of KNOWN_FIELD_KEYS) {
    const newValue = input.payload[fieldName];
    if (newValue == null) continue;
    const confidence = factConfidence.get(fieldName) ?? FIELD_CONFIDENCE_FALLBACK;
    rows.push({
      diffId: input.diffId,
      fieldName,
      newValue,
      confidence: String(confidence),
      isAutoApproved: confidence >= 0.9
    });
  }

  if (rows.length === 0) return;
  await input.db.insert(schema.proposedDiffFields).values(rows);
}
