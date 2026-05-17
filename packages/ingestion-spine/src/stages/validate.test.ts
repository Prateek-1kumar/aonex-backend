import { describe, it, expect } from "bun:test";
import { runValidate } from "./validate.js";
import type { MappedFactSet } from "@aonex/ingestion-semantic-mapper";

function makeMockDb(categorySchema: Record<string, unknown> | null) {
  return {
    query: {
      categorySchemas: {
        findFirst: async () => categorySchema
          ? {
              categoryPath: "outdoor/camping/tents",
              schemaVersion: 1,
              tier: "authoritative",
              jsonSchema: categorySchema,
              requiredAttributes: ["capacity_persons", "season_rating"]
            }
          : null
      }
    }
  };
}

const tentSchema = {
  $schema: "https://json-schema.org/draft/2019-09/schema",
  tier: "authoritative",
  required: ["capacity_persons", "season_rating"],
  properties: {
    capacity_persons: { type: "integer" },
    season_rating: { type: "string", enum: ["3-season", "4-season"] }
  },
  additionalProperties: true
};

function makeMappedFactSet(attributes: Record<string, unknown>): MappedFactSet {
  return {
    original: {} as never,
    facts: Object.entries(attributes).map(([k, v]) => ({
      rawKey: k,
      canonicalPath: k,
      extractedValue: v,
      normalizedValue: v,
      unit: null,
      sourcePointer: `$.${k}`,
      extractionMethod: "direct" as const,
      mappingMethod: "auto",
      mappingCandidates: [{ key: k, score: 0.9 }],
      sourceAlternatives: null,
      confidence: 0.9,
      approved: true
    })),
    mapperVersion: "test-1",
    categoryPath: "outdoor/camping/tents",
    mappedAt: new Date()
  };
}

describe("runValidate — Tier 1 strict", () => {
  it("passes when all required attributes present", async () => {
    const db = makeMockDb(tentSchema);
    const result = await runValidate({
      db: db as never,
      mappedFactSet: makeMappedFactSet({
        capacity_persons: 2,
        season_rating: "3-season"
      })
    });
    expect(result.valid).toBe(true);
    expect(result.missingRequired).toEqual([]);
    expect(result.tier).toBe("authoritative");
    expect(result.requiredAttributes).toEqual(["capacity_persons", "season_rating"]);
  });

  it("returns missingRequired when required absent", async () => {
    const db = makeMockDb(tentSchema);
    const result = await runValidate({
      db: db as never,
      mappedFactSet: makeMappedFactSet({ capacity_persons: 2 })
    });
    expect(result.valid).toBe(false);
    expect(result.missingRequired).toContain("season_rating");
  });
});

describe("runValidate — Tier 2 / no schema", () => {
  it("auto-passes when no category schema exists for the path", async () => {
    const db = makeMockDb(null);
    const result = await runValidate({
      db: db as never,
      mappedFactSet: makeMappedFactSet({ anything: "goes" })
    });
    expect(result.valid).toBe(true);
    expect(result.tier).toBe("inferred");
    expect(result.requiredAttributes).toEqual([]);
  });
});
