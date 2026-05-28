// packages/ingestion-eval/src/promote-metrics.ts
import type { Decision } from "./types.js";

export interface PromoteMetrics {
  /** North metric: of auto-promoted products, the fraction correct on fields AND dedup. */
  autoPromotePrecision: number;
  /** Guardrail: fraction of all products that were auto-promoted. */
  autoPromoteRate: number;
  autoPromotedCount: number;
  total: number;
}

export function promoteMetrics(decisions: Decision[]): PromoteMetrics {
  const total = decisions.length;
  const auto = decisions.filter((d) => d.autoPromoted);
  const correct = auto.filter((d) => d.fieldsCorrect && d.dedupCorrect);
  const div = (a: number, b: number) => (b === 0 ? 0 : a / b);
  return {
    autoPromotePrecision: div(correct.length, auto.length),
    autoPromoteRate: div(auto.length, total),
    autoPromotedCount: auto.length,
    total,
  };
}
