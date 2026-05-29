import { test, expect } from "bun:test";
import { backfillGtin } from "./lookup.js";

test("returns multiple candidates from independent registries (no pick-and-pray)", async () => {
  const res = await backfillGtin(
    { title: "Google Pixel 10 5G", brand: "Google", mpn: "GP10" },
    {
      icecat:    async () => ({ gtin: "0111", title: "Pixel 10 5G", brand: "Google" }),
      upcitemdb: async () => ({ gtin: "0111", title: "Google Pixel 10", brand: "Google" }),
      budgetLeft: () => true,
    }
  );
  expect(res.candidates.map((c) => c.value)).toContain("0111");
  expect(res.candidates.length).toBe(2);          // both registries returned
  expect(res.candidates.every((c) => c.corroborated === false)).toBe(true);   // raw candidates start weak
});

test("skips lookups when over budget", async () => {
  const res = await backfillGtin(
    { title: "x", brand: "y" },
    {
      icecat:    async () => ({ gtin: "0", title: "x", brand: "y" }),
      upcitemdb: async () => null,
      budgetLeft: () => false,
    }
  );
  expect(res.candidates).toEqual([]);
  expect(res.skipped).toBe("budget");
});

test("a registry returning null is silently skipped", async () => {
  const res = await backfillGtin(
    { title: "obscure", brand: "x" },
    {
      icecat:    async () => null,
      upcitemdb: async () => ({ gtin: "0222", title: "obscure", brand: "x" }),
      budgetLeft: () => true,
    }
  );
  expect(res.candidates.length).toBe(1);
  expect(res.candidates[0]!.source).toBe("backfill:upcitemdb");
});
