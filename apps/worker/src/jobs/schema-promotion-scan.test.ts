import { describe, it, expect } from "bun:test";
import { runSchemaPromotionScan } from "./schema-promotion-scan.js";

interface CapturedDraft {
  categoryPath: string;
  tier: string;
  jsonSchema: Record<string, unknown>;
  requiredAttributes: string[];
}

function makeMockDb(opts: {
  productsByCategory: Record<string, Array<Record<string, unknown>>>;
  /** Set of category paths that already have a tier='authoritative' schema */
  existingAuthoritative: Set<string>;
}) {
  const drafts: CapturedDraft[] = [];

  return {
    // Aggregate query mock — returns the shape runSchemaPromotionScan expects.
    execute: async (_sqlStr: unknown) => {
      return Object.entries(opts.productsByCategory).map(([categoryPath, products]) => ({
        canonical_category: categoryPath,
        total_products: products.length,
        attribute_distributions: aggregateKeys(products)
      }));
    },
    query: {
      categorySchemas: {
        findFirst: async (config: { where: (c: unknown, ops: { and: unknown; eq: (a: unknown, b: unknown) => unknown }) => unknown }) => {
          // Inspect the where callback to extract the categoryPath being looked up.
          let capturedPath: string | null = null;
          const fakeEq = (col: unknown, val: unknown) => {
            if (typeof col === "object" && col !== null && "name" in col && (col as { name: string }).name === "categoryPath") {
              capturedPath = val as string;
            }
            return null;
          };
          config.where({ categoryPath: { name: "categoryPath" }, tier: { name: "tier" } }, { and: (a: unknown, _b: unknown) => a, eq: fakeEq });
          if (capturedPath && opts.existingAuthoritative.has(capturedPath)) {
            return { categoryPath: capturedPath, tier: "authoritative" };
          }
          return null;
        }
      }
    },
    insert: (_table: unknown) => ({
      values: (v: CapturedDraft) => ({
        onConflictDoNothing: () => Promise.resolve()
      })
    }),
    _captureInsert: (v: CapturedDraft) => drafts.push(v),
    _drafts: drafts
  };
}

function aggregateKeys(products: Array<Record<string, unknown>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of products) {
    const attrs = (p.attributes_json ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(attrs)) counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

describe("runSchemaPromotionScan", () => {
  it("proposes a draft when >=50 products + >=8 consistent keys + no existing Tier 1", async () => {
    const products = Array.from({ length: 60 }, () => ({
      attributes_json: {
        capacity_persons: 2,
        season_rating: "3-season",
        packed_weight_grams: 2400,
        peak_height_cm: 110,
        waterproof_rating_mm: 2000,
        color: "Green",
        pole_material: "fibreglass",
        footprint_area_sq_m: 3.2
      }
    }));
    const db = makeMockDb({
      productsByCategory: { "outdoor/camping/3-season-tents": products },
      existingAuthoritative: new Set()
    });

    const result = await runSchemaPromotionScan({
      db: db as never,
      thresholds: { minProducts: 50, minKeys: 8, minConsistency: 0.8 }
    });

    expect(result.examined).toBe(1);
    expect(result.proposedDrafts).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("does NOT propose when fewer than minProducts", async () => {
    const products = Array.from({ length: 10 }, () => ({
      attributes_json: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 }
    }));
    const db = makeMockDb({
      productsByCategory: { "x/y/z": products },
      existingAuthoritative: new Set()
    });
    const result = await runSchemaPromotionScan({
      db: db as never,
      thresholds: { minProducts: 50, minKeys: 8, minConsistency: 0.8 }
    });
    expect(result.examined).toBe(1);
    expect(result.proposedDrafts).toBe(0);
  });

  it("does NOT propose when fewer than minKeys reach minConsistency", async () => {
    const products = Array.from({ length: 100 }, (_v, i) => ({
      attributes_json: {
        // Only 4 keys present in 100% of products
        title: `t${i}`,
        brand: `b${i}`,
        gtin: `${i}`,
        currency: "USD"
        // Other keys (color, size, etc.) absent — fail minKeys=8
      }
    }));
    const db = makeMockDb({
      productsByCategory: { "x/y/z": products },
      existingAuthoritative: new Set()
    });
    const result = await runSchemaPromotionScan({
      db: db as never,
      thresholds: { minProducts: 50, minKeys: 8, minConsistency: 0.8 }
    });
    expect(result.proposedDrafts).toBe(0);
  });

  it("uses DEFAULT_THRESHOLDS when not supplied", async () => {
    const db = makeMockDb({
      productsByCategory: {},
      existingAuthoritative: new Set()
    });
    const result = await runSchemaPromotionScan({ db: db as never });
    expect(result.examined).toBe(0);
    expect(result.proposedDrafts).toBe(0);
  });
});
