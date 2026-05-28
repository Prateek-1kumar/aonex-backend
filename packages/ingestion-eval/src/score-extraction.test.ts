// packages/ingestion-eval/src/score-extraction.test.ts
import { test, expect } from "bun:test";
import { scoreProduct, aggregate } from "./score-extraction.js";
import type { GoldenProduct } from "./types.js";

const golden: GoldenProduct = {
  id: "p1", sourceUrl: "x", archetype: "smartphone", split: "regression",
  rawHtmlPath: "x.html",
  labels: { title: "Pixel 10", brand: "Google", base_price: 79999 },
};

test("scoreProduct marks each field correct/incorrect with its weight", () => {
  const scored = scoreProduct(golden, { title: "Pixel 10", brand: "Google", base_price: 71000 });
  const byField = Object.fromEntries(scored.map((s) => [s.field, s.correct]));
  expect(byField.title).toBe(true);
  expect(byField.brand).toBe(true);
  expect(byField.base_price).toBe(false); // >1% off
});

test("aggregate weights price errors heavily", () => {
  // brand+title correct (0.8+0.8) but price wrong (1.0) => precision below 0.7
  const scored = scoreProduct(golden, { title: "Pixel 10", brand: "Google", base_price: 71000 });
  const report = aggregate([scored]);
  expect(report.weightedRecall).toBeCloseTo((0.8 + 0.8) / (0.8 + 0.8 + 1), 5);
});
