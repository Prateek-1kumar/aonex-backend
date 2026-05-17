import { describe, it, expect } from "bun:test";
import { runCalibrationRefit } from "./calibration-refit.js";

function makeMockDb(rows: Array<{
  extractor: string;
  category: string | null;
  source_type: string;
  raw_confidence: number;
  outcome: 0 | 1;
}>) {
  return {
    execute: async () => rows
  };
}

describe("runCalibrationRefit", () => {
  it("returns empty result when no rows match", async () => {
    const db = makeMockDb([]);
    const result = await runCalibrationRefit({ db: db as never });
    expect(result.groupsExamined).toBe(0);
    expect(result.fitted).toEqual([]);
  });

  it("groups samples by (extractor × category × source_type)", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      extractor: i < 30 ? "json-ld@1.0" : "llm-url@1.0",
      category: "electronics/televisions",
      source_type: "link_url",
      raw_confidence: 0.5 + (i % 10) / 20,
      outcome: (i % 2 === 0 ? 1 : 0) as 0 | 1
    }));
    const db = makeMockDb(rows);
    const result = await runCalibrationRefit({
      db: db as never,
      minSamplesPerGroup: 10
    });
    expect(result.groupsExamined).toBe(2);
    expect(result.groupsFitted).toBe(2);
  });

  it("skips groups below minSamplesPerGroup", async () => {
    const rows = Array.from({ length: 5 }, () => ({
      extractor: "json-ld@1.0",
      category: "x/y",
      source_type: "link_url",
      raw_confidence: 0.8,
      outcome: 1 as 0 | 1
    }));
    const db = makeMockDb(rows);
    const result = await runCalibrationRefit({ db: db as never, minSamplesPerGroup: 10 });
    expect(result.groupsExamined).toBe(1);
    expect(result.groupsFitted).toBe(0);
    expect(result.groupsSkippedBelowMin).toBe(1);
  });

  it("produces a non-empty isotonic model when enough samples present", async () => {
    const rows: Array<{ extractor: string; category: string | null; source_type: string; raw_confidence: number; outcome: 0 | 1 }> = [];
    for (let i = 0; i < 30; i++) rows.push({ extractor: "e", category: "c", source_type: "link_url", raw_confidence: 0.3, outcome: 0 });
    for (let i = 0; i < 30; i++) rows.push({ extractor: "e", category: "c", source_type: "link_url", raw_confidence: 0.9, outcome: 1 });
    const db = makeMockDb(rows);
    const result = await runCalibrationRefit({ db: db as never, minSamplesPerGroup: 10 });
    expect(result.fitted).toHaveLength(1);
    expect(result.fitted[0]!.model.thresholds.length).toBeGreaterThan(0);
  });

  it("handles null categories (groups them under the same null key)", async () => {
    const rows = Array.from({ length: 20 }, () => ({
      extractor: "e",
      category: null,
      source_type: "link_url",
      raw_confidence: 0.5,
      outcome: 1 as 0 | 1
    }));
    const db = makeMockDb(rows);
    const result = await runCalibrationRefit({ db: db as never, minSamplesPerGroup: 10 });
    expect(result.fitted).toHaveLength(1);
    expect(result.fitted[0]!.key.category).toBeNull();
  });
});
