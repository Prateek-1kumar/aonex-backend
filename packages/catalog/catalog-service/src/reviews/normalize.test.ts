import { test, expect } from "bun:test";
import { normalizeReview, dedupeKey } from "./normalize.js";

test("normalizes a raw review and computes a stable dedupe key", () => {
  const r = normalizeReview({
    source: "amazon",
    author: "Sam P.",
    rating: 5,
    text: "Great!",
    date: "2026-01-02",
  });
  expect(r.rating).toBe(5);
  expect(r.dedupeKey).toBe(dedupeKey("amazon", "Sam P.", "Great!"));
});

test("same author+source+text dedupes; different text does not", () => {
  expect(dedupeKey("amazon", "Sam", "A")).toBe(dedupeKey("amazon", "sam", " a "));
  expect(dedupeKey("amazon", "Sam", "A")).not.toBe(dedupeKey("amazon", "Sam", "B"));
});
