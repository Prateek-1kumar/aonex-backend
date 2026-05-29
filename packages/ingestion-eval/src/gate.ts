import type { Decision } from "./types.js";
import { promoteMetrics, type PromoteMetrics } from "./promote-metrics.js";

/** Thresholds encode spec §2.4 SLOs. */
export const DEFAULT_THRESHOLDS = {
  minAutoPromotePrecision: 0.98, // shippable-at-scale precision bar
  maxDrift: 0.05,                // regression-vs-holdout precision gap tolerance
} as const;

export interface GateInput {
  decisions: Decision[];
  regressionPrecision: number;
  holdoutPrecision: number;
  thresholds?: typeof DEFAULT_THRESHOLDS;
}

export interface GateResult {
  pass: boolean;
  metrics: PromoteMetrics;
  drift: number;
  reasons: string[];
}

export function evaluateGate(input: GateInput): GateResult {
  const t = input.thresholds ?? DEFAULT_THRESHOLDS;
  const metrics = promoteMetrics(input.decisions);
  const drift = Math.abs(input.regressionPrecision - input.holdoutPrecision);
  const reasons: string[] = [];
  if (metrics.autoPromotePrecision < t.minAutoPromotePrecision) {
    reasons.push(`auto-promote precision ${metrics.autoPromotePrecision.toFixed(3)} < ${t.minAutoPromotePrecision}`);
  }
  if (drift > t.maxDrift) {
    reasons.push(`regression-vs-holdout drift ${drift.toFixed(3)} > ${t.maxDrift} (eval may be stale)`);
  }
  return { pass: reasons.length === 0, metrics, drift, reasons };
}
