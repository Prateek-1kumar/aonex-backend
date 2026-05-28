// packages/archetypes/src/classify.test.ts
import { test, expect } from "bun:test";
import { classifyArchetype } from "./classify.js";

test("classifies by category keyword", () => {
  expect(classifyArchetype({ categoryPath: "phones_&_wearables/mobile_phones", title: "X", brand: "Google" })).toBe("smartphone");
});

test("classifies by title when category is absent", () => {
  expect(classifyArchetype({ title: "Google Pixel 10 5G", brand: "Google" })).toBe("smartphone");
});

test("returns 'unknown' when nothing matches", () => {
  expect(classifyArchetype({ title: "Stainless Steel Water Bottle 1L", brand: "Acme" })).toBe("unknown");
});
