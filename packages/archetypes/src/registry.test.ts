// packages/archetypes/src/registry.test.ts
import { test, expect } from "bun:test";
import { getArchetype, listArchetypes } from "./registry.js";

test("smartphone seed is registered with required price + identity", () => {
  const a = getArchetype("smartphone");
  expect(a).toBeDefined();
  const req = new Set(a!.attributes.filter((x) => x.tier === "required").map((x) => x.field));
  expect(req.has("base_price")).toBe(true);
  expect(req.has("title")).toBe(true);
  expect(listArchetypes().length).toBeGreaterThanOrEqual(1);
});

test("unknown archetype returns undefined", () => {
  expect(getArchetype("nope")).toBeUndefined();
});
