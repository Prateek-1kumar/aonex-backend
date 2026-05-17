import { describe, it, expect } from "bun:test";
import { runScore } from "./score.js";
import type { MappedFactSet } from "@aonex/ingestion-semantic-mapper";

// ---------------------------------------------------------------------------
// Helpers — build the minimum MappedFactSet and attribute map for runScore.
// We use the real route() function (no mocking per spec).
// ---------------------------------------------------------------------------

function makeHighConfidenceFact(rawKey: string, value: unknown): MappedFactSet["facts"][number] {
  return {
    rawKey,
    canonicalPath: rawKey,
    extractedValue: value,
    normalizedValue: value,
    unit: null,
    sourcePointer: `$.${rawKey}`,
    extractionMethod: "direct",
    mappingMethod: "auto",
    mappingCandidates: [{ key: rawKey, score: 0.95 }],
    sourceAlternatives: null,
    confidence: 0.95,
    approved: true
  };
}

function makeMappedFactSet(overrides: Partial<MappedFactSet> = {}): MappedFactSet {
  return {
    original: {} as never,
    facts: [
      makeHighConfidenceFact("title", "Mountain Tent"),
      makeHighConfidenceFact("brand", "OutdoorCo"),
      makeHighConfidenceFact("base_price", 299),
      makeHighConfidenceFact("currency", "USD")
    ],
    mapperVersion: "test-1",
    categoryPath: "outdoor/camping/tents",
    mappedAt: new Date(),
    ...overrides
  };
}

// Stub db — runScore accepts db/tenantId but does not use them yet.
const stubDb = {} as never;

describe("runScore — auto_approve path", () => {
  it("returns auto_approve when inputs are clean and no required attributes are missing", async () => {
    const result = await runScore({
      db: stubDb,
      tenantId: "tenant-1" as never,
      mappedFactSet: makeMappedFactSet(),
      attributes: {
        title: "Mountain Tent",
        brand: "OutdoorCo",
        basePrice: 299,
        currency: "USD"
      },
      categoryConfidence: 0.95,
      domain: "outdoorco.com",
      categoryRequiredAttributes: []  // no required attrs → no missing_required_attribute signal
    });

    expect(result.route).toBe("auto_approve");
    expect(result.reviewTasks).toEqual([]);
    expect(result.score).toBe(1.0);
    expect(result.evidence.detectorsRun.length).toBeGreaterThan(0);
    expect(result.evidence.detectorsTripped).toEqual([]);
  });
});

describe("runScore — review path", () => {
  it("returns review when a required attribute is missing", async () => {
    const result = await runScore({
      db: stubDb,
      tenantId: "tenant-1" as never,
      mappedFactSet: makeMappedFactSet(),
      attributes: {
        title: "Mountain Tent",
        brand: "OutdoorCo",
        basePrice: 299,
        currency: "USD"
      },
      categoryConfidence: 0.95,
      domain: "outdoorco.com",
      // category_persons_capacity is required but not in facts → detector fires
      categoryRequiredAttributes: ["capacity_persons"]
    });

    expect(result.route).toBe("review");
    expect(result.reviewTasks.length).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThan(1.0);
    expect(result.evidence.detectorsTripped).toContain("missing_required_attribute");
  });

  it("returns review when a fact has low mapping confidence", async () => {
    const lowConfFact = { ...makeHighConfidenceFact("title", "Tent"), confidence: 0.55 };
    const factSet = makeMappedFactSet({ facts: [lowConfFact] });

    const result = await runScore({
      db: stubDb,
      tenantId: "tenant-1" as never,
      mappedFactSet: factSet,
      attributes: { title: "Tent" },
      categoryConfidence: 0.95,
      domain: "outdoorco.com",
      categoryRequiredAttributes: []
    });

    expect(result.route).toBe("review");
    expect(result.evidence.detectorsTripped).toContain("low_confidence_mapping");
  });
});
