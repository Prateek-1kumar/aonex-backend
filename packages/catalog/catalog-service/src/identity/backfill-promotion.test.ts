import { test, expect } from "bun:test";
import { promoteBackfill } from "./backfill-promotion.js";

const ours = { title: "Google Pixel 10 5G", brand: "Google" };

test("promotes to strong when 2 independent sources agree AND round-trip passes", () => {
  const r = promoteBackfill({
    gtin: "0111",
    ours,
    sources: ["backfill:icecat", "backfill:upcitemdb"],
    registryProduct: { title: "Pixel 10 5G", brand: "Google" },
  });
  expect(r.promote).toBe(true);
});

test("stays candidate on a single source even if round-trip passes", () => {
  const r = promoteBackfill({
    gtin: "0111",
    ours,
    sources: ["backfill:icecat"],
    registryProduct: { title: "Pixel 10 5G", brand: "Google" },
  });
  expect(r.promote).toBe(false);
  expect(r.reason).toContain("corroboration");
});

test("blocks promotion when round-trip mismatches even with 2 sources", () => {
  const r = promoteBackfill({
    gtin: "0111",
    ours,
    sources: ["backfill:icecat", "live:croma"],
    registryProduct: { title: "Samsung Galaxy S25", brand: "Samsung" },
  });
  expect(r.promote).toBe(false);
  expect(r.reason).toContain("round-trip");
});

test("rejects when no sources are supplied", () => {
  const r = promoteBackfill({
    gtin: "0111", ours,
    sources: [],
    registryProduct: { title: "Pixel 10", brand: "Google" },
  });
  expect(r.promote).toBe(false);
  expect(r.reason).toContain("corroboration");
});
