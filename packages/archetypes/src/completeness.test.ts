// packages/archetypes/src/completeness.test.ts
import { test, expect } from "bun:test";
import { scoreCompleteness, hardFloorOk } from "./completeness.js";
import { getArchetype } from "./registry.js";

const arch = getArchetype("smartphone")!;

test("full required set scores 1.0 and meets threshold", () => {
  const present = new Set(["title", "brand", "base_price", "currency", "identifier", "category_path"]);
  const r = scoreCompleteness(arch, present, { threshold: 0.8, identifierExists: true });
  expect(r.score).toBeCloseTo(1, 5);
  expect(r.meetsThreshold).toBe(true);
  expect(r.missingRequired).toEqual([]);
});

test("missing price+identity tanks the score (heavy weights) and lists them by weight", () => {
  const present = new Set(["title", "brand", "category_path"]);
  const r = scoreCompleteness(arch, present, { threshold: 0.8, identifierExists: false });
  // present required weight = 0.8+0.8+0.6 = 2.2 ; total required = 0.8+0.8+1+1+1+0.6 = 5.2
  expect(r.score).toBeCloseTo(2.2 / 5.2, 5);
  expect(r.meetsThreshold).toBe(false);
  expect(r.missingRequired[0]).toBe("base_price"); // weight 1, ordered first
});

test("hard floor needs title + (identifier present OR identifier_exists=false)", () => {
  expect(hardFloorOk(new Set(["title"]), false)).toBe(true);          // escape hatch
  expect(hardFloorOk(new Set(["title", "identifier"]), true)).toBe(true);
  expect(hardFloorOk(new Set(["brand"]), true)).toBe(false);          // no title
  expect(hardFloorOk(new Set(["title"]), true)).toBe(false);          // claims id exists but none present
});
