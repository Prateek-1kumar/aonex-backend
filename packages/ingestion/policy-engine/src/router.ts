import { createHash } from "node:crypto";
import type { Detector, ReviewTaskSignal, RouterInput, RoutingDecision, SignalKind, DetectorSeverity } from "./types.js";
import { detectLowFieldConfidence } from "./detectors/low-field-confidence.js";
import { detectMissingRequiredAttribute } from "./detectors/missing-required-attribute.js";
import { detectCrossSourceConflict } from "./detectors/cross-source-conflict.js";
import { detectUnitAmbiguity } from "./detectors/unit-ambiguity.js";
import { detectIdentityConflict } from "./detectors/identity-conflict.js";
import { detectCategoryAmbiguous } from "./detectors/category-ambiguous.js";
import { detectVariantIncomplete } from "./detectors/variant-incomplete.js";
import { detectPriceAnomaly } from "./detectors/price-anomaly.js";
import { detectValueContradiction } from "./detectors/value-contradiction.js";

const DETECTORS: { kind: SignalKind; fn: Detector }[] = [
  { kind: "low_confidence_mapping", fn: detectLowFieldConfidence },
  { kind: "missing_required_attribute", fn: detectMissingRequiredAttribute },
  { kind: "field_conflict", fn: detectCrossSourceConflict },
  { kind: "unit_conflict", fn: detectUnitAmbiguity },
  { kind: "potential_duplicate", fn: detectIdentityConflict },
  { kind: "category_ambiguous", fn: detectCategoryAmbiguous },
  { kind: "variant_incomplete", fn: detectVariantIncomplete },
  { kind: "price_anomaly", fn: detectPriceAnomaly },
  { kind: "value_contradiction", fn: detectValueContradiction },
];

const SEV_WEIGHTS: Record<DetectorSeverity, number> = {
  low: 0.05,
  medium: 0.15,
  high: 0.25,
  critical: 0.45,
};

export function route(input: RouterInput): RoutingDecision {
  const signals: ReviewTaskSignal[] = [];
  const tripped: SignalKind[] = [];
  for (const d of DETECTORS) {
    const s = d.fn(input);
    if (s) {
      signals.push(s);
      tripped.push(d.kind);
    }
  }
  if (signals.length === 0) {
    return {
      route: "auto_approve",
      reviewTasks: [],
      score: 1.0,
      evidence: { detectorsRun: DETECTORS.map((d) => d.kind), detectorsTripped: [] },
    };
  }
  const drop = signals.reduce((acc, s) => acc + SEV_WEIGHTS[s.severity], 0);
  const score = Math.max(0, 1.0 - drop);
  return {
    route: "review",
    reviewTasks: signals,
    score,
    evidence: { detectorsRun: DETECTORS.map((d) => d.kind), detectorsTripped: tripped },
  };
}

export function clusterKey(signal: ReviewTaskSignal): string {
  const parts: Record<string, string> = { signal_kind: signal.signalKind, ...signal.clusterDimensions };
  const sortedKeys = Object.keys(parts).sort();
  const sorted: Record<string, string> = {};
  for (const k of sortedKeys) sorted[k] = parts[k]!;
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}
