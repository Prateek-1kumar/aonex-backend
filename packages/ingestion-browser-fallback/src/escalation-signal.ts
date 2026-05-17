/**
 * Spec §6.3 — decide whether to escalate from static fetch to browser render.
 * Cheap heuristics on the raw HTML — no network call. Conservative: requires
 * at least 2 signals to escalate (avoid spending browser cost on simple pages).
 */
export interface EscalationSignalInput {
  rawHtml: string;
  hasJsonLd: boolean;
  hasNextData: boolean;
  hasNuxt: boolean;
  /** 0..1 — fraction of expected fields the static parse extracted */
  coveragePercent: number;
}

export interface EscalationDecision {
  escalate: boolean;
  reasons: string[];
}

const BODY_THRESHOLD_BYTES = 30_000;
const NOSCRIPT_ENABLE_JS = /<noscript>[^<]*enable[^<]*(?:java)?script/i;
const COVERAGE_THRESHOLD = 0.5;
const REQUIRED_SIGNALS = 2;

export function shouldEscalateToBrowser(opts: EscalationSignalInput): EscalationDecision {
  const reasons: string[] = [];

  if (opts.rawHtml.length < BODY_THRESHOLD_BYTES) reasons.push(`body_under_${BODY_THRESHOLD_BYTES / 1000}kb`);
  if (NOSCRIPT_ENABLE_JS.test(opts.rawHtml)) reasons.push("noscript_enable_js");
  if (!opts.hasJsonLd && !opts.hasNextData && !opts.hasNuxt) reasons.push("no_structured_data");
  if (opts.coveragePercent < COVERAGE_THRESHOLD) {
    reasons.push(`coverage_${(opts.coveragePercent * 100).toFixed(0)}pct_below_50`);
  }

  return { escalate: reasons.length >= REQUIRED_SIGNALS, reasons };
}
