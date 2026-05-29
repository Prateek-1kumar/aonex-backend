// packages/ingestion-eval/src/promote-metrics.test.ts
import { test, expect } from "bun:test";
import { promoteMetrics } from "./promote-metrics.js";
import type { Decision } from "./types.js";

const decisions: Decision[] = [
  { id: "a", autoPromoted: true,  fieldsCorrect: true,  dedupCorrect: true },
  { id: "b", autoPromoted: true,  fieldsCorrect: true,  dedupCorrect: false }, // wrong merge
  { id: "c", autoPromoted: false, fieldsCorrect: true,  dedupCorrect: true },  // went to Lab
  { id: "d", autoPromoted: true,  fieldsCorrect: false, dedupCorrect: true },  // wrong field
];

test("auto-promote precision counts only fully-correct auto-promotions", () => {
  const m = promoteMetrics(decisions);
  // auto-promoted: a,b,d (3). correct (fields&dedup): only a (1). => 1/3
  expect(m.autoPromotePrecision).toBeCloseTo(1 / 3, 5);
});

test("auto-promote rate is auto-promoted / total", () => {
  const m = promoteMetrics(decisions);
  expect(m.autoPromoteRate).toBeCloseTo(3 / 4, 5);
});

test("empty input yields zeroed metrics, never NaN", () => {
  const m = promoteMetrics([]);
  expect(m.autoPromotePrecision).toBe(0);
  expect(m.autoPromoteRate).toBe(0);
});
