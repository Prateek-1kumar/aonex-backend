import { describe, it, expect } from "bun:test";
import { persistDiffFields } from "./persist-diff-fields.js";
import type { ExtractedFact } from "@aonex/ingestion-field-extractor";

// ---------------------------------------------------------------------------
// Minimal DB stub — captures the row payload passed to .values().
// ---------------------------------------------------------------------------

interface CapturedInsert {
  rows: Array<Record<string, unknown>>;
}

function makeCaptureDb(captured: CapturedInsert) {
  return {
    insert: () => ({
      values: (rows: Array<Record<string, unknown>>) => {
        captured.rows.push(...rows);
        return Promise.resolve();
      }
    })
  };
}

function makeFact(partial: Partial<ExtractedFact>): ExtractedFact {
  return {
    rawKey: partial.rawKey ?? "title",
    canonicalPath: partial.canonicalPath ?? "title",
    extractedValue: partial.extractedValue ?? "value",
    normalizedValue: partial.normalizedValue ?? "value",
    unit: null,
    sourcePointer: "$.title",
    extractionMethod: "direct",
    confidence: partial.confidence ?? 0.95,
    mappingMethod: "test",
    mappingCandidates: null,
    sourceAlternatives: null,
    approved: true,
    ...partial
  };
}

describe("persistDiffFields — no-op when payload is empty", () => {
  it("inserts nothing when payload has no known field keys", async () => {
    const captured: CapturedInsert = { rows: [] };
    const db = makeCaptureDb(captured);

    await persistDiffFields({
      db: db as never,
      diffId: "diff-1",
      payload: { unknownKey: "ignored" },
      facts: []
    });

    expect(captured.rows.length).toBe(0);
  });
});

describe("persistDiffFields — high-confidence facts → all rows isAutoApproved", () => {
  it("emits rows for present known fields with isAutoApproved=true when confidence ≥ 0.9", async () => {
    const captured: CapturedInsert = { rows: [] };
    const db = makeCaptureDb(captured);

    await persistDiffFields({
      db: db as never,
      diffId: "diff-1",
      payload: {
        title: "Big Tent",
        brand: "Acme",
        basePrice: 199
      },
      facts: [
        makeFact({ canonicalPath: "title", confidence: 0.95 }),
        makeFact({ canonicalPath: "brand", confidence: 0.92 }),
        makeFact({ canonicalPath: "basePrice", confidence: 0.91 })
      ]
    });

    expect(captured.rows.length).toBe(3);
    for (const row of captured.rows) {
      expect(row.isAutoApproved).toBe(true);
      expect(row.diffId).toBe("diff-1");
    }
    const fieldNames = captured.rows.map((r) => r.fieldName).sort();
    expect(fieldNames).toEqual(["basePrice", "brand", "title"]);
  });
});

describe("persistDiffFields — fallback confidence when no fact maps to the field", () => {
  it("falls back to 0.6 / isAutoApproved=false when payload field has no matching fact", async () => {
    const captured: CapturedInsert = { rows: [] };
    const db = makeCaptureDb(captured);

    await persistDiffFields({
      db: db as never,
      diffId: "diff-1",
      payload: { title: "Generic Item" },
      facts: [] // no facts → fallback path
    });

    expect(captured.rows.length).toBe(1);
    const row = captured.rows[0]!;
    expect(row.fieldName).toBe("title");
    expect(row.confidence).toBe("0.6");
    expect(row.isAutoApproved).toBe(false);
  });
});
