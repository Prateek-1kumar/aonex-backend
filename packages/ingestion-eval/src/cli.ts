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
  // Placeholder wiring until Phase 0 records real outputs: exits 0 on empty.
  const code = await runEval({
    products: [], loadExtracted: async () => ({}),
    decisionsOverride: [], regressionPrecision: 1, holdoutPrecision: 1,
  });
  process.exit(code);
}
