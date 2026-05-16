import { describe, it, expect } from "bun:test";
import { runMap } from "./map.js";
import type { ExtractedFactSet } from "@aonex/ingestion-field-extractor";

// ---------------------------------------------------------------------------
// Mock DB — returns the 4 corpus tables as empty arrays (or with override rows
// to exercise the merchantId filter inside loadMapperCorpus).
// ---------------------------------------------------------------------------

function makeFactSet(): ExtractedFactSet {
  return {
    artifactId: "art-1" as never,
    marketplace: "link_url",
    extractorVersion: "test-1",
    facts: [
      {
        rawKey: "title",
        canonicalPath: null,
        extractedValue: "Test Product",
        normalizedValue: null,
        unit: null,
        sourcePointer: "$.title",
        extractionMethod: "direct",
        mappingMethod: null,
        mappingCandidates: null,
        sourceAlternatives: null,
        confidence: 0.95,
        approved: false
      }
    ],
    extractedAt: new Date()
  };
}

function makeMockDb(
  overrides: Array<{ tenantId: string; merchantId: string | null; sourceKey: string; canonicalKey: string; priority: number }> = []
) {
  // Each call to select() returns a builder. The builder's from() method:
  //   - for mapping_overrides: returns an object with a where() that resolves to the overrides list
  //   - for other tables: resolves directly to []
  // The real drizzle chain is: db.select().from(table) → then optionally .where(cond) → Promise
  // We handle both with and without .where() chaining.
  const makeFromResult = (rows: Array<unknown>) => {
    const thenable = Object.assign(Promise.resolve(rows), {
      where: (_condition: unknown) => Promise.resolve(rows)
    });
    return thenable;
  };

  return {
    select: () => ({
      from: (table: unknown) => {
        const tableName = (table as { _?: { name?: string } } | undefined)?._?.name ?? "";
        if (tableName === "mapping_overrides") {
          return makeFromResult(overrides);
        }
        return makeFromResult([]);
      }
    })
  };
}

describe("runMap", () => {
  it("calls semanticMap with corpus shape and returns MappedFactSet", async () => {
    const db = makeMockDb();
    const factSet = makeFactSet();

    const result = await runMap({
      db: db as never,
      tenantId: "tenant-1" as never,
      merchantId: "merchant-1" as never,
      factSet,
      categoryHint: null
    });

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.rawKey).toBe("title");
    expect(result.mapperVersion).toBeTruthy();
    expect(result.original).toBe(factSet);
  });

  it("loads corpus from DB and runs semanticMap without error when overrides are filtered (smoke)", async () => {
    // Include one matching and one non-matching override to exercise the
    // merchantId filter in loadMapperCorpus.
    // The merchantId filter (o.merchantId === merchantId) is exercised here; to
    // assert the exclusion directly would require intercepting semanticMap or
    // refactoring runMap to expose the corpus. Keeping as a smoke test for now.
    const db = makeMockDb([
      {
        tenantId: "tenant-1",
        merchantId: "merchant-1",  // matches → included
        sourceKey: "vendor",
        canonicalKey: "product.brand",
        priority: 100
      },
      {
        tenantId: "tenant-1",
        merchantId: "merchant-OTHER",  // does not match → excluded
        sourceKey: "mfr",
        canonicalKey: "product.manufacturer",
        priority: 100
      }
    ]);

    const factSet = makeFactSet();

    const result = await runMap({
      db: db as never,
      tenantId: "tenant-1" as never,
      merchantId: "merchant-1" as never,
      factSet,
      categoryHint: "outdoor/camping"
    });

    expect(result.facts).toHaveLength(1);
    // categoryHint is threaded through as categoryPath
    expect(result.categoryPath).toBe("outdoor/camping");
  });
});
