// packages/archetypes/src/types.test.ts
import { test, expect } from "bun:test";
import type { Archetype, AttributeSpec, CompletenessResult } from "./types.js";

test("shapes hold", () => {
  const a: AttributeSpec = { field: "base_price", tier: "required", weight: 1 };
  const arch: Archetype = { id: "smartphone", label: "Smartphone", attributes: [a] };
  const r: CompletenessResult = { score: 0.5, meetsThreshold: false, missingRequired: ["gtin"], missingRecommended: [], hardFloorOk: true };
  expect(arch.attributes[0]!.tier).toBe("required");
  expect(r.missingRequired).toContain("gtin");
});
