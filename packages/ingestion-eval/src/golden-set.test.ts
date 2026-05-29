// packages/ingestion-eval/src/golden-set.test.ts
import { test, expect } from "bun:test";
import { loadGoldenSet, splitBy } from "./golden-set.js";

test("loads valid fixtures and rejects malformed ones", async () => {
  const dir = `${import.meta.dir}/../fixtures/golden/_test`;
  const { products, errors } = await loadGoldenSet(dir);
  expect(products.find((p) => p.id === "ok-1")).toBeDefined();
  expect(errors.some((e) => e.includes("bad.json"))).toBe(true);
});

test("splitBy separates regression and holdout", () => {
  const { regression, holdout } = splitBy([
    { id: "a", sourceUrl: "x", archetype: "s", split: "regression", rawHtmlPath: "x", labels: {} },
    { id: "b", sourceUrl: "x", archetype: "s", split: "holdout", rawHtmlPath: "x", labels: {} },
  ]);
  expect(regression.length).toBe(1);
  expect(holdout.length).toBe(1);
});
