import { test, expect } from "bun:test";
import type { GoldenProduct, Decision, ScoredField } from "./types.js";

test("GoldenProduct shape accepts a labeled fixture", () => {
  const g: GoldenProduct = {
    id: "croma-pixel-10",
    sourceUrl: "https://croma.com/...",
    archetype: "smartphone",
    split: "regression",
    rawHtmlPath: "fixtures/golden/croma-pixel-10.html",
    labels: { title: "Google Pixel 10 5G", base_price: 79999, currency: "INR" },
    variantKeys: { storage: "256GB" },
  };
  expect(g.split).toBe("regression");
});

test("Decision and ScoredField shapes hold", () => {
  const d: Decision = { id: "x", autoPromoted: true, fieldsCorrect: true, dedupCorrect: true };
  const s: ScoredField = { field: "base_price", expected: 1, extracted: 1, correct: true, weight: 1, rawConfidence: 0.9 };
  expect(d.autoPromoted && s.correct).toBe(true);
});
