import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { withinCostCeiling, creditsToUsd, COST_CONSTANTS } from "./cost-ceiling.js";

describe("withinCostCeiling", () => {
  const originalEnv = process.env["EXTRACTION_COST_CEILING_USD"];
  beforeEach(() => {
    delete process.env["EXTRACTION_COST_CEILING_USD"];
  });
  afterEach(() => {
    if (originalEnv !== undefined) process.env["EXTRACTION_COST_CEILING_USD"] = originalEnv;
    else delete process.env["EXTRACTION_COST_CEILING_USD"];
  });

  it("allows under-budget request (5 + 5 credits = $0.001)", () => {
    expect(withinCostCeiling(5, 5)).toBe(true);
  });

  it("rejects request that would exceed default $0.05 ceiling", () => {
    // 500 credits + 100 = 600 credits = $0.06 > $0.05
    expect(withinCostCeiling(500, 100)).toBe(false);
  });

  it("respects EXTRACTION_COST_CEILING_USD env override", () => {
    process.env["EXTRACTION_COST_CEILING_USD"] = "0.20";
    expect(withinCostCeiling(500, 100)).toBe(true);    // $0.06 < $0.20
  });

  it("falls back to default when env is invalid", () => {
    process.env["EXTRACTION_COST_CEILING_USD"] = "not-a-number";
    expect(withinCostCeiling(500, 100)).toBe(false);    // uses default $0.05
  });
});

describe("creditsToUsd", () => {
  it("converts credits at $0.0001 each", () => {
    expect(creditsToUsd(100)).toBeCloseTo(0.01);
    expect(creditsToUsd(0)).toBe(0);
  });
});

describe("COST_CONSTANTS", () => {
  it("exposes the constants", () => {
    expect(COST_CONSTANTS.CREDIT_TO_USD).toBe(0.0001);
    expect(COST_CONSTANTS.DEFAULT_CEILING_USD).toBe(0.05);
  });
});
