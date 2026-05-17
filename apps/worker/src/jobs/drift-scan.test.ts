import { describe, it, expect } from "bun:test";
import { runDriftScan } from "./drift-scan.js";

function makeMockDb(rows: Array<{
  canonical_category: string;
  title: string | null;
  brand: string | null;
  gtin: string | null;
  model_number: string | null;
  base_price: number | null;
  currency: string | null;
  attributes_json: Record<string, unknown> | null;
  in_current: boolean;
}>) {
  return {
    execute: async () => rows
  };
}

describe("runDriftScan", () => {
  it("returns no per-category entries when no rows", async () => {
    const db = makeMockDb([]);
    const result = await runDriftScan({ db: db as never });
    expect(result.perCategory).toEqual([]);
  });

  it("skips categories with missing baseline OR current", async () => {
    // Only baseline rows, no current
    const rows = Array.from({ length: 5 }, () => ({
      canonical_category: "x/y",
      title: "ok", brand: "b", gtin: "g", model_number: "m",
      base_price: 10, currency: "USD",
      attributes_json: null,
      in_current: false
    }));
    const db = makeMockDb(rows);
    const result = await runDriftScan({ db: db as never });
    expect(result.perCategory).toEqual([]);
  });

  it("detects field-level null-rate drift", async () => {
    const baseline = Array.from({ length: 100 }, () => ({
      canonical_category: "electronics/tvs" as string,
      title: "x", brand: "y", gtin: "g", model_number: "m",
      base_price: 999 as number | null,
      currency: "USD",
      attributes_json: null,
      in_current: false
    }));
    // current: 50% have null gtin (was 0% in baseline)
    const current = Array.from({ length: 50 }, (_, i) => ({
      canonical_category: "electronics/tvs" as string,
      title: "x", brand: "y",
      gtin: i < 25 ? null : "g",
      model_number: "m",
      base_price: 999 as number | null,
      currency: "USD",
      attributes_json: null,
      in_current: true
    }));
    const db = makeMockDb([...baseline, ...current]);
    const result = await runDriftScan({ db: db as never });
    const tvCat = result.perCategory.find((c) => c.category === "electronics/tvs");
    expect(tvCat).toBeDefined();
    const gtinDrift = tvCat!.nullRateDrift.find((d) => d.field === "gtin");
    expect(gtinDrift?.drifted).toBe(true);
  });

  it("returns category counts in the report", async () => {
    const baseline = [{
      canonical_category: "x",
      title: "a", brand: "b", gtin: "c", model_number: "d",
      base_price: 10 as number | null, currency: "USD",
      attributes_json: null,
      in_current: false
    }];
    const current = [{
      canonical_category: "x",
      title: "a", brand: "b", gtin: "c", model_number: "d",
      base_price: 10 as number | null, currency: "USD",
      attributes_json: null,
      in_current: true
    }];
    const db = makeMockDb([...baseline, ...current]);
    const result = await runDriftScan({ db: db as never });
    expect(result.perCategory[0]!.baselineCount).toBe(1);
    expect(result.perCategory[0]!.currentCount).toBe(1);
  });
});
