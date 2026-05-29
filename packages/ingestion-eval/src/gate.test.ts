import { test, expect } from "bun:test";
import { evaluateGate, DEFAULT_THRESHOLDS } from "./gate.js";
import type { Decision } from "./types.js";

test("gate passes when precision >= bar and drift within tolerance", () => {
  const decisions: Decision[] = Array.from({ length: 100 }, (_, i) => ({
    id: String(i), autoPromoted: true, fieldsCorrect: i >= 1, dedupCorrect: true, // 99% correct
  }));
  const res = evaluateGate({ decisions, regressionPrecision: 0.99, holdoutPrecision: 0.98 });
  expect(res.pass).toBe(true);
});

test("gate fails when auto-promote precision is below the 0.98 bar", () => {
  const decisions: Decision[] = Array.from({ length: 100 }, (_, i) => ({
    id: String(i), autoPromoted: true, fieldsCorrect: i >= 10, dedupCorrect: true, // 90%
  }));
  const res = evaluateGate({ decisions, regressionPrecision: 0.9, holdoutPrecision: 0.9 });
  expect(res.pass).toBe(false);
  expect(res.reasons.some((r) => r.includes("precision"))).toBe(true);
});

test("gate fails on large regression-vs-holdout drift (eval lying)", () => {
  const decisions: Decision[] = Array.from({ length: 100 }, (_, i) => ({
    id: String(i), autoPromoted: true, fieldsCorrect: true, dedupCorrect: true,
  }));
  const res = evaluateGate({ decisions, regressionPrecision: 0.99, holdoutPrecision: 0.80 });
  expect(res.pass).toBe(false);
  expect(res.reasons.some((r) => r.includes("drift"))).toBe(true);
});

test("default thresholds encode the locked SLOs", () => {
  expect(DEFAULT_THRESHOLDS.minAutoPromotePrecision).toBe(0.98);
  expect(DEFAULT_THRESHOLDS.maxDrift).toBe(0.05);
});
