// idempotency.test.ts
import { test, expect } from "bun:test";
import { contentHash, isDuplicateIngest } from "./idempotency.js";

test("same normalized payload -> same hash", () => {
  expect(contentHash({ title: "X", price: 1 })).toBe(contentHash({ price: 1, title: "X" }));
});

test("isDuplicateIngest true when hash already seen for this source record", () => {
  const h = contentHash({ title: "X" });
  expect(isDuplicateIngest(h, [h])).toBe(true);
  expect(isDuplicateIngest(h, ["other"])).toBe(false);
});
