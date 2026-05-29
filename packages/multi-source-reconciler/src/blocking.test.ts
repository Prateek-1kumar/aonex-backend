import { test, expect } from "bun:test";
import { blockingKeys } from "./blocking.js";

test("blocks on normalized brand + archetype", () => {
  const k = blockingKeys({ brand: "SAMSUNG", archetype: "smartphone", title: "Galaxy S25 256GB" });
  expect(k).toContain("brand:samsung|arch:smartphone");
});

test("adds a title-prefix block to catch missing-brand cases", () => {
  const k = blockingKeys({ archetype: "smartphone", title: "Galaxy S25 256GB" });
  expect(k.some((x) => x.startsWith("titletok:"))).toBe(true);
});
