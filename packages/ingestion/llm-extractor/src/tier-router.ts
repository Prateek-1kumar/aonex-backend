// Two-tier model router for LLM gap-fill.
// LIGHT: fast/cheap model for easy fills (few gaps + JSON-LD + small page).
// HEAVY: heavier model for harder cases.
// Both env vars are overridable: GROQ_MODEL_GAP_FILL_LIGHT / GROQ_MODEL_GAP_FILL_HEAVY.

export interface ModelChoice {
  model: string;
  maxTokens: number;
}

export function pickModel(ctx: { gaps: string[]; hasJsonLd: boolean; cleanedTextLen: number }): ModelChoice {
  const isEasy =
    ctx.gaps.length <= 3 &&
    ctx.hasJsonLd &&
    ctx.cleanedTextLen < 50_000;
  return isEasy
    ? { model: process.env["GROQ_MODEL_GAP_FILL_LIGHT"] || "llama-3.1-8b-instant", maxTokens: 800 }
    : { model: process.env["GROQ_MODEL_GAP_FILL_HEAVY"] || "llama-3.3-70b-versatile", maxTokens: 2_000 };
}

// Text budget shrinks when structured data already covers most fields.
export function decideTextBudget(coverage: number): number {
  if (coverage >= 0.7) return 5_000;
  if (coverage >= 0.4) return 15_000;
  return 30_000;
}

// Center-preserving truncation matching the html-cleaner pattern.
export function truncateCenterPreserving(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 30) / 2);
  return text.substring(0, half) + "\n[...middle truncated]\n" + text.substring(text.length - half);
}
