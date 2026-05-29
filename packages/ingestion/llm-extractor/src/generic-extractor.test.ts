import { test, expect } from "bun:test";
import { fitIsotonic } from "@aonex/calibration";
import { getArchetype } from "@aonex/archetypes";
import { genericExtract } from "./generic-extractor.js";

const model = fitIsotonic([
  { rawConfidence: 0.9, outcome: 1 },
  { rawConfidence: 0.9, outcome: 1 },
]);

test("asks the model only for needed fields and returns calibrated facts", async () => {
  const calls: string[][] = [];
  const out = await genericExtract({
    archetype: getArchetype("smartphone")!,
    structured: { title: { value: "Pixel 10", confidence: 0.95 } }, // confident → not re-asked
    cleanedText: "…page text…",
    calibration: model,
    callModel: async (schemaFields) => {
      calls.push(schemaFields);
      return { brand: { value: "Google", rawConfidence: 0.9 } };
    },
  });
  expect(calls[0]).toContain("brand");
  expect(calls[0]).not.toContain("title");
  expect(out.find((f) => f.field === "brand")?.value).toBe("Google");
});

test("returns empty when nothing needs the LLM (all fast-path)", async () => {
  let called = false;
  const out = await genericExtract({
    archetype: getArchetype("smartphone")!,
    // every required+recommended field present at ≥CONFIDENT
    structured: {
      title:         { value: "X", confidence: 0.95 },
      brand:         { value: "Y", confidence: 0.95 },
      base_price:    { value: 1,   confidence: 0.95 },
      currency:      { value: "USD", confidence: 0.95 },
      identifier:    { value: "G",   confidence: 0.95 },
      category_path: { value: "p",   confidence: 0.95 },
      images:        { value: ["u"], confidence: 0.95 },
      storage:       { value: "256GB", confidence: 0.95 },
      color:         { value: "Obsidian", confidence: 0.95 },
      ram:           { value: 12,    confidence: 0.95 },
    },
    cleanedText: "…",
    calibration: model,
    callModel: async () => { called = true; return {}; },
  });
  expect(called).toBe(false);
  expect(out).toEqual([]);
});
