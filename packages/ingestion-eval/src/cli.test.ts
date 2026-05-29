import { test, expect } from "bun:test";
import { runEval } from "./cli.js";

test("runEval returns exit code 0 when the gate passes", async () => {
  const code = await runEval({
    products: [],
    loadExtracted: async () => ({}),
    // No products => no auto-promotions; force-pass by supplying decisions directly:
    decisionsOverride: Array.from({ length: 100 }, (_, i) => ({
      id: String(i), autoPromoted: true, fieldsCorrect: true, dedupCorrect: true,
    })),
    regressionPrecision: 0.99,
    holdoutPrecision: 0.99,
    print: () => {},
  });
  expect(code).toBe(0);
});

test("runEval returns exit code 1 when the gate fails", async () => {
  const code = await runEval({
    products: [],
    loadExtracted: async () => ({}),
    decisionsOverride: Array.from({ length: 100 }, (_, i) => ({
      id: String(i), autoPromoted: true, fieldsCorrect: i >= 50, dedupCorrect: true,
    })),
    regressionPrecision: 0.5,
    holdoutPrecision: 0.5,
    print: () => {},
  });
  expect(code).toBe(1);
});

test("runEval skips with exit 0 when no decisions are supplied", async () => {
  let printed = "";
  const code = await runEval({
    products: [],
    loadExtracted: async () => ({}),
    decisionsOverride: [],
    regressionPrecision: 1,
    holdoutPrecision: 1,
    print: (l) => { printed = l; },
  });
  expect(code).toBe(0);
  expect(printed).toContain("skipped");
});
