import { computeMatchScore, THRESHOLDS, type ProductIdentity, type MatchScoreBreakdown } from "./scoring.js";

/**
 * Spec §6.8 — field-level reconciliation policy for two product candidates.
 *
 * Higher-confidence value wins; tie → most-recent source wins.
 * Returns a merged record + an audit of which side each field came from.
 */

export interface Field<T = unknown> {
  value: T | null;
  confidence: number;
  /** Lower = older. Used as tiebreak when confidences are equal. */
  observedAt: number;
}

export interface ReconciledRecord {
  /** Field name → chosen value */
  fields: Record<string, unknown | null>;
  /** Field name → which side won (a | b | both-empty) */
  attribution: Record<string, "a" | "b" | "neither">;
}

export type ReconciliationAction = "merge" | "review" | "keep_separate";

export interface ReconciliationDecision {
  action: ReconciliationAction;
  score: MatchScoreBreakdown;
}

/**
 * Pick the higher-confidence value per field. Tie-break: more recent.
 * Null/undefined values are skipped (the other side wins by default).
 */
export function reconcileFields(
  a: Record<string, Field>,
  b: Record<string, Field>
): ReconciledRecord {
  const fields: Record<string, unknown | null> = {};
  const attribution: Record<string, "a" | "b" | "neither"> = {};
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);

  for (const key of allKeys) {
    const fa = a[key];
    const fb = b[key];
    const aPresent = fa && fa.value !== null && fa.value !== undefined;
    const bPresent = fb && fb.value !== null && fb.value !== undefined;

    if (!aPresent && !bPresent) {
      fields[key] = null;
      attribution[key] = "neither";
    } else if (!aPresent) {
      fields[key] = fb!.value;
      attribution[key] = "b";
    } else if (!bPresent) {
      fields[key] = fa!.value;
      attribution[key] = "a";
    } else {
      // Both present — higher confidence wins; tie → more recent
      if (fa.confidence > fb.confidence) {
        fields[key] = fa.value;
        attribution[key] = "a";
      } else if (fb.confidence > fa.confidence) {
        fields[key] = fb.value;
        attribution[key] = "b";
      } else {
        // Tie on confidence — most recent wins
        if (fa.observedAt >= fb.observedAt) {
          fields[key] = fa.value;
          attribution[key] = "a";
        } else {
          fields[key] = fb.value;
          attribution[key] = "b";
        }
      }
    }
  }
  return { fields, attribution };
}

/**
 * Decide the reconciliation action based on the composite identity score.
 */
export function decideReconciliationAction(
  a: ProductIdentity,
  b: ProductIdentity
): ReconciliationDecision {
  const score = computeMatchScore(a, b);
  let action: ReconciliationAction;
  if (score.composite >= THRESHOLDS.AUTO_MERGE) action = "merge";
  else if (score.composite >= THRESHOLDS.REVIEW) action = "review";
  else action = "keep_separate";
  return { action, score };
}
