// Per-URL extraction budget. Soft cap; on overrun the orchestrator
// ships partial results and flags `_extraction_meta.budget_exceeded`.

export interface UrlBudget {
  maxLlmCalls: number;
  maxVisionCalls: number;
  maxWallMs: number;
  maxCostUsd: number;
}

export const DEFAULT_BUDGET: UrlBudget = {
  maxLlmCalls: 1,
  maxVisionCalls: 1,
  maxWallMs: 30_000,
  maxCostUsd: 0.03
};

export interface BudgetSnapshot {
  llmCalls: number;
  visionCalls: number;
  costUsd: number;
  wallMs: number;
  exceeded: boolean;
}

export class BudgetTracker {
  private readonly startedAt = Date.now();
  private llmCalls = 0;
  private visionCalls = 0;
  private costUsd = 0;

  constructor(private readonly budget: UrlBudget = DEFAULT_BUDGET) {}

  canCallLlm(): boolean {
    return this.llmCalls < this.budget.maxLlmCalls && this.withinTimeAndCost();
  }

  canCallVision(): boolean {
    return this.visionCalls < this.budget.maxVisionCalls && this.withinTimeAndCost();
  }

  recordLlm(costUsd: number): void {
    this.llmCalls += 1;
    this.costUsd += costUsd;
  }

  recordVision(costUsd: number): void {
    this.visionCalls += 1;
    this.costUsd += costUsd;
  }

  snapshot(): BudgetSnapshot {
    const wallMs = Date.now() - this.startedAt;
    return {
      llmCalls: this.llmCalls,
      visionCalls: this.visionCalls,
      costUsd: this.costUsd,
      wallMs,
      exceeded: !this.withinTimeAndCost()
    };
  }

  private withinTimeAndCost(): boolean {
    return (Date.now() - this.startedAt) < this.budget.maxWallMs && this.costUsd < this.budget.maxCostUsd;
  }
}
