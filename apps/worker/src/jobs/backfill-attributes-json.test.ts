import { describe, it, expect } from "bun:test";
import { backfillAttributesJson } from "./backfill-attributes-json.js";

// Mock the drizzle client. The select chain returns paged results.
// The update chain captures attempted writes.
function makeMockDb(rows: Array<{
  id: string;
  merchantExtensionsJson: { attributes?: Record<string, unknown>; evidence?: Record<string, unknown> } | null;
  attributesJson: Record<string, unknown> | null;
}>) {
  const updates: Array<{ id: string; attributesJson: Record<string, unknown>; evidenceSummary: Record<string, unknown> | null }> = [];
  let lastSetValues: { attributesJson: Record<string, unknown>; evidenceSummary?: Record<string, unknown> | null } | null = null;

  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (n: number) => ({
            offset: (o: number) => Promise.resolve(rows.slice(o, o + n))
          })
        })
      })
    }),
    update: () => ({
      set: (v: { attributesJson: Record<string, unknown>; evidenceSummary?: Record<string, unknown> | null }) => {
        lastSetValues = v;
        return {
          where: (_clause: unknown) => {
            // The implementation MUST call .where(eq(productVersions.id, row.id)).
            // To match each update to a row id, the impl will produce one .where(...) per .set(...).
            // Capture the last set values keyed by an out-of-band marker (the row pos).
            if (lastSetValues) {
              updates.push({
                id: `row-${updates.length}`,
                attributesJson: lastSetValues.attributesJson,
                evidenceSummary: lastSetValues.evidenceSummary ?? null
              });
              lastSetValues = null;
            }
            return Promise.resolve();
          }
        };
      }
    }),
    _updates: updates
  };
}

describe("backfillAttributesJson", () => {
  it("counts rows in dry-run without writing", async () => {
    const db = makeMockDb([
      {
        id: "v1",
        merchantExtensionsJson: {
          attributes: { color: "Red", material: "cotton" },
          evidence: { sourceUrl: "https://example.com/p1" }
        },
        attributesJson: null
      },
      {
        id: "v2",
        merchantExtensionsJson: { attributes: { ram_gb: 8 } },
        attributesJson: null
      }
    ]);

    const result = await backfillAttributesJson({
      db: db as never,
      dryRun: true,
      chunkSize: 10
    });

    expect(result.examined).toBe(2);
    expect(result.wouldUpdate).toBe(2);
    expect(result.updated).toBe(0);
    expect(db._updates).toHaveLength(0);
  });

  it("skips rows that already have a non-empty attributes_json", async () => {
    const db = makeMockDb([
      {
        id: "v1",
        merchantExtensionsJson: { attributes: { color: "Red" } },
        attributesJson: { capacity_persons: 2 }
      }
    ]);

    const result = await backfillAttributesJson({
      db: db as never,
      dryRun: false,
      chunkSize: 10
    });

    expect(result.examined).toBe(1);
    expect(result.wouldUpdate).toBe(0);
    expect(result.updated).toBe(0);
    expect(db._updates).toHaveLength(0);
  });

  it("skips rows where merchant_extensions_json has no attributes key", async () => {
    const db = makeMockDb([
      {
        id: "v1",
        merchantExtensionsJson: { evidence: { x: 1 } },
        attributesJson: null
      }
    ]);

    const result = await backfillAttributesJson({
      db: db as never,
      dryRun: false,
      chunkSize: 10
    });

    expect(result.wouldUpdate).toBe(0);
    expect(result.updated).toBe(0);
  });

  it("writes attributes_json and evidence_summary in live mode", async () => {
    const db = makeMockDb([
      {
        id: "v1",
        merchantExtensionsJson: {
          attributes: { capacity_persons: 2, season_rating: "3-season" },
          evidence: { sourceUrl: "https://example.com/tent" }
        },
        attributesJson: null
      }
    ]);

    const result = await backfillAttributesJson({
      db: db as never,
      dryRun: false,
      chunkSize: 10
    });

    expect(result.examined).toBe(1);
    expect(result.wouldUpdate).toBe(1);
    expect(result.updated).toBe(1);
    expect(db._updates).toHaveLength(1);
    expect(db._updates[0]!.attributesJson).toEqual({
      capacity_persons: 2,
      season_rating: "3-season"
    });
    expect(db._updates[0]!.evidenceSummary).toEqual({ sourceUrl: "https://example.com/tent" });
  });

  it("pages through chunks until exhausted", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `v${i}`,
      merchantExtensionsJson: { attributes: { idx: i } },
      attributesJson: null
    }));
    const db = makeMockDb(rows);

    const result = await backfillAttributesJson({
      db: db as never,
      dryRun: false,
      chunkSize: 10
    });

    expect(result.examined).toBe(25);
    expect(result.wouldUpdate).toBe(25);
    expect(result.updated).toBe(25);
  });
});
