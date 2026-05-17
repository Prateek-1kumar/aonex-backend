/**
 * Spec §6.4 — ScrapingBee credit costs. Enforce a per-request USD ceiling so
 * a single ingestion can't blow the budget when escalating to premium proxies.
 */
export const COST_CONSTANTS = {
  CREDIT_TO_USD: 0.0001,       // Hobby tier: $49 / 250k credits ≈ $0.0001/credit
  DEFAULT_CEILING_USD: 0.05    // ceiling per ingestion
};

function ceilingUsd(): number {
  const raw = process.env["EXTRACTION_COST_CEILING_USD"];
  if (raw == null) return COST_CONSTANTS.DEFAULT_CEILING_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : COST_CONSTANTS.DEFAULT_CEILING_USD;
}

export function withinCostCeiling(currentCredits: number, additionalCredits: number): boolean {
  const projectedUsd = (currentCredits + additionalCredits) * COST_CONSTANTS.CREDIT_TO_USD;
  return projectedUsd <= ceilingUsd();
}

export function creditsToUsd(credits: number): number {
  return credits * COST_CONSTANTS.CREDIT_TO_USD;
}
