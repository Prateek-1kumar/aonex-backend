import { describe, it, expect } from "bun:test";
import { BudgetTracker, DEFAULT_BUDGET } from "./budget.js";

describe("BudgetTracker", () => {
  it("allows first LLM call within budget", () => {
    const b = new BudgetTracker();
    expect(b.canCallLlm()).toBe(true);
  });

  it("blocks second LLM call when max is 1", () => {
    const b = new BudgetTracker();
    b.recordLlm(0.001);
    expect(b.canCallLlm()).toBe(false);
  });

  it("blocks vision when cost ceiling exceeded", () => {
    const b = new BudgetTracker({ maxLlmCalls: 5, maxVisionCalls: 5, maxWallMs: 60_000, maxCostUsd: 0.005 });
    b.recordLlm(0.01); // already over the ceiling
    expect(b.canCallVision()).toBe(false);
  });

  it("snapshot reports cumulative spend", () => {
    const b = new BudgetTracker();
    b.recordLlm(0.001);
    b.recordVision(0.002);
    const s = b.snapshot();
    expect(s.llmCalls).toBe(1);
    expect(s.visionCalls).toBe(1);
    expect(s.costUsd).toBeCloseTo(0.003, 5);
  });

  it("respects custom budget", () => {
    const b = new BudgetTracker({ maxLlmCalls: 3, maxVisionCalls: 0, maxWallMs: 60_000, maxCostUsd: 100 });
    expect(b.canCallVision()).toBe(false);
    expect(b.canCallLlm()).toBe(true);
  });

  it("DEFAULT_BUDGET is exported", () => {
    expect(DEFAULT_BUDGET).toBeDefined();
    expect(DEFAULT_BUDGET.maxLlmCalls).toBeGreaterThan(0);
  });
});
