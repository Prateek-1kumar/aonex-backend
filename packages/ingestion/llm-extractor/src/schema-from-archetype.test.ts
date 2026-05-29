import { test, expect } from "bun:test";
import { schemaFromArchetype } from "./schema-from-archetype.js";
import { getArchetype } from "@aonex/archetypes";

test("required attributes become required schema properties", () => {
  const s = schemaFromArchetype(getArchetype("smartphone")!);
  expect(s.properties.base_price).toBeDefined();
  expect(s.required).toContain("base_price");
  expect(s.required).toContain("title");
  expect(s.required).not.toContain("description_long"); // optional
});
