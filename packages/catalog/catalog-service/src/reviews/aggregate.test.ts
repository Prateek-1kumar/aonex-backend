import { test, expect } from "bun:test";
import { aggregateReviews } from "./aggregate.js";

test("count-weighted mean across sources", () => {
  const a = aggregateReviews([
    { source: "amazon",   avg: 4.5, count: 100 },
    { source: "flipkart", avg: 4.0, count: 50  },
  ]);
  expect(a.count).toBe(150);
  expect(a.average).toBeCloseTo((4.5 * 100 + 4.0 * 50) / 150, 3);
});

test("empty -> zero, never NaN", () => {
  const a = aggregateReviews([]);
  expect(a.count).toBe(0);
  expect(a.average).toBe(0);
});
