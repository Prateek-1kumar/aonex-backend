// packages/ingestion-eval/src/seed.test.ts
import { test, expect } from "bun:test";
import { loadGoldenSet } from "./golden-set.js";

test("seed golden set loads with zero errors and both splits present", async () => {
  const { products, errors } = await loadGoldenSet(`${import.meta.dir}/../fixtures/golden`);
  expect(errors).toEqual([]);
  expect(products.length).toBeGreaterThanOrEqual(2);
  expect(products.some((p) => p.split === "regression")).toBe(true);
  expect(products.some((p) => p.split === "holdout")).toBe(true);
});
