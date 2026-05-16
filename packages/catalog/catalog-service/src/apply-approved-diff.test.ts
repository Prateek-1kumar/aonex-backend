import { describe, it, expect } from "bun:test";
import { applyApprovedDiff, type CanonicalProductPayload } from "./index.js";

// Mock the drizzle client. Captures inserts/updates so tests can assert on row content.
function makeMockDb(opts: {
  diff: {
    id: string;
    tenantId: string;
    merchantId: string;
    productId: string | null;
    diffPayload: Record<string, unknown>;
    confidenceScore: string;
    sourceFactSetId?: string;
  };
  categorySchema: Record<string, unknown> | null;
  existingVersion?: { id: string; productId: string } | null;
}) {
  const insertedVersions: Array<Record<string, unknown>> = [];
  const insertedProducts: Array<Record<string, unknown>> = [];
  const insertedReviewTasks: Array<Record<string, unknown>> = [];
  const productUpdates: Array<Record<string, unknown>> = [];
  const diffUpdates: Array<Record<string, unknown>> = [];

  const queries = {
    proposedDiffs: { findFirst: async () => opts.diff },
    productVersions: { findFirst: async () => opts.existingVersion ?? null },
    categorySchemas: { findFirst: async () => opts.categorySchema },
    productIdentities: { findFirst: async () => null },
    productVariants: { findFirst: async () => null },
    extractedFacts: { findMany: async () => [] }
  };

  let mockIdCounter = 0;
  const tableNameOf = (table: unknown): string => {
    const sym = Object.getOwnPropertySymbols(table as object).find(
      (s) => s.description === "drizzle:Name"
    );
    return sym ? ((table as Record<symbol, unknown>)[sym] as string) : "";
  };

  return {
    query: queries,
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown> | Record<string, unknown>[]) => ({
        returning: () => {
          const name = tableNameOf(table);
          const rows = Array.isArray(v) ? v : [v];
          const target =
            name === "products" ? insertedProducts
            : name === "review_tasks" ? insertedReviewTasks
            : name === "product_versions" ? insertedVersions
            : null;
          if (target) target.push(...rows);
          mockIdCounter += 1;
          return Promise.resolve(rows.map(() => ({ id: `mock-id-${mockIdCounter}` })));
        },
        onConflictDoNothing: () => Promise.resolve()
      })
    }),
    update: (table: unknown) => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          const name = tableNameOf(table);
          if (name === "products") productUpdates.push(v);
          else if (name === "proposed_diffs") diffUpdates.push(v);
          return Promise.resolve();
        }
      })
    }),
    _insertedVersions: insertedVersions,
    _insertedProducts: insertedProducts,
    _insertedReviewTasks: insertedReviewTasks,
    _productUpdates: productUpdates,
    _diffUpdates: diffUpdates
  };
}

const tentSchema = {
  $schema: "https://json-schema.org/draft/2019-09/schema",
  $id: "category_schemas/outdoor_camping_tents/v1_test",
  tier: "authoritative",
  required: [
    "capacity_persons",
    "season_rating",
    "packed_weight_grams",
    "peak_height_cm",
    "waterproof_rating_mm"
  ],
  properties: {
    capacity_persons: { type: "integer" },
    season_rating: { type: "string", enum: ["3-season", "4-season"] },
    packed_weight_grams: { type: "number" },
    peak_height_cm: { type: "number" },
    waterproof_rating_mm: { type: "number" }
  },
  additionalProperties: true
};

const completeTentPayload: CanonicalProductPayload = {
  title: "MH100 2-Person Tent",
  brand: "Quechua",
  gtin: "3608451234567",
  gtinType: null,
  modelNumber: null,
  manufacturerPartNumber: "8492348",
  description: null,
  basePrice: 49.99,
  currency: "EUR",
  weightGrams: 2400,
  dimensionsCm: { l: 58, w: 16, h: 16 },
  canonicalCategory: "outdoor/camping/tents",
  categorySchemaVersion: "2026-05-08.tents.v1",
  categoryConfidence: 0.94,
  images: [],
  attributes: {
    capacity_persons: 2,
    season_rating: "3-season",
    packed_weight_grams: 2400,
    peak_height_cm: 110,
    waterproof_rating_mm: 2000,
    color: "Green"
  },
  variants: [],
  evidence: { sourceUrl: "https://decathlon.com/mh100" }
};

describe("applyApprovedDiff — Phase 1 canonical schema", () => {
  it("populates attributes_json and the new typed columns on Tier 1 success", async () => {
    const db = makeMockDb({
      diff: {
        id: "diff-1",
        tenantId: "tenant-1",
        merchantId: "merchant-1",
        productId: null,
        diffPayload: completeTentPayload as unknown as Record<string, unknown>,
        confidenceScore: "0.87",
        sourceFactSetId: "fact-set-1"
      },
      categorySchema: { ...tentSchema, categoryPath: "outdoor/camping/tents", schemaVersion: 1, jsonSchema: tentSchema }
    });

    const result = await applyApprovedDiff({
      db: db as never,
      diffId: "diff-1",
      approvalStatus: "auto_approved"
    });

    expect(result.productVersionId).toBeTruthy();
    expect(db._insertedVersions).toHaveLength(1);

    const row = db._insertedVersions[0]!;
    expect(row.attributesJson).toEqual({
      capacity_persons: 2,
      season_rating: "3-season",
      packed_weight_grams: 2400,
      peak_height_cm: 110,
      waterproof_rating_mm: 2000,
      color: "Green"
    });
    expect(row.weightGrams).toBe("2400");                  // drizzle coerces numeric → string
    expect(row.dimensionsCm).toEqual({ l: 58, w: 16, h: 16 });
    expect(row.manufacturerPartNumber).toBe("8492348");
    expect(row.categorySchemaVersion).toBe("outdoor/camping/tents/v1");
    expect(row.categoryConfidence).toBe("0.94");
    expect(row.evidenceSummary).toEqual({ sourceUrl: "https://decathlon.com/mh100" });
    expect(row.merchantExtensionsJson).toBe(null);
    // Sanity: diff status was updated before product_version insert
    expect(db._diffUpdates.some((u) => u.status === "auto_approved")).toBe(true);
  });

  it("opens missing_required_attribute review task when Tier 1 required field is absent", async () => {
    const incompletePayload: CanonicalProductPayload = {
      ...completeTentPayload,
      attributes: {
        capacity_persons: 2,
        packed_weight_grams: 2400,
        peak_height_cm: 110,
        waterproof_rating_mm: 2000
        // missing season_rating
      }
    };
    const db = makeMockDb({
      diff: {
        id: "diff-2",
        tenantId: "tenant-1",
        merchantId: "merchant-1",
        productId: null,
        diffPayload: incompletePayload as unknown as Record<string, unknown>,
        confidenceScore: "0.87",
        sourceFactSetId: "fact-set-2"
      },
      categorySchema: { ...tentSchema, categoryPath: "outdoor/camping/tents", schemaVersion: 1, jsonSchema: tentSchema }
    });

    await expect(
      applyApprovedDiff({
        db: db as never,
        diffId: "diff-2",
        approvalStatus: "auto_approved"
      })
    ).rejects.toThrow(/missing required/i);

    expect(db._insertedVersions).toHaveLength(0);
    expect(db._insertedReviewTasks).toHaveLength(1);
    const task = db._insertedReviewTasks[0]!;
    expect(task.taskType).toBe("missing_required_attribute");
    expect((task.signalPayload as Record<string, unknown>).missingRequired).toEqual(["season_rating"]);
    expect(task.severity).toBe("medium");
    // Sanity: diff status was NOT updated to auto_approved (validation failed first)
    expect(db._diffUpdates.some((u) => u.status === "auto_approved")).toBe(false);
  });

  it("does NOT validate when category_schema is Tier 2 (inferred)", async () => {
    const umbrellaPayload: CanonicalProductPayload = {
      title: "Auto-Open Umbrella",
      brand: "StormGuard",
      gtin: null,
      gtinType: null,
      modelNumber: null,
      manufacturerPartNumber: null,
      description: null,
      basePrice: 24.99,
      currency: "USD",
      weightGrams: 380,
      dimensionsCm: null,
      canonicalCategory: "luggage_bags/umbrellas",
      categorySchemaVersion: null,
      categoryConfidence: 0.82,
      images: [],
      attributes: {
        color: "Black",
        opening_mechanism: "automatic"
      },
      variants: [],
      evidence: {}
    };

    const db = makeMockDb({
      diff: {
        id: "diff-3",
        tenantId: "tenant-1",
        merchantId: "merchant-1",
        productId: null,
        diffPayload: umbrellaPayload as unknown as Record<string, unknown>,
        confidenceScore: "0.81",
        sourceFactSetId: "fact-set-3"
      },
      categorySchema: {
        categoryPath: "luggage_bags/umbrellas",
        schemaVersion: 1,
        tier: "inferred",
        jsonSchema: {
          $schema: "https://json-schema.org/draft/2019-09/schema",
          $id: "category_schemas/luggage_bags_umbrellas/v0_inferred_test",
          tier: "inferred",
          required: [],
          properties: {},
          additionalProperties: true
        }
      }
    });

    const result = await applyApprovedDiff({
      db: db as never,
      diffId: "diff-3",
      approvalStatus: "auto_approved"
    });

    expect(result.productVersionId).toBeTruthy();
    const row = db._insertedVersions[0]!;
    expect(row.attributesJson).toEqual({
      color: "Black",
      opening_mechanism: "automatic"
    });
    expect(row.categorySchemaVersion).toBe(null);
    expect(db._insertedReviewTasks).toHaveLength(0);
  });

  it("idempotent — returns existing version if one already exists for this diff", async () => {
    const db = makeMockDb({
      diff: {
        id: "diff-4",
        tenantId: "tenant-1",
        merchantId: "merchant-1",
        productId: "prod-4",
        diffPayload: completeTentPayload as unknown as Record<string, unknown>,
        confidenceScore: "0.87",
        sourceFactSetId: "fact-set-4"
      },
      categorySchema: { ...tentSchema, categoryPath: "outdoor/camping/tents", schemaVersion: 1, jsonSchema: tentSchema },
      existingVersion: { id: "ver-existing", productId: "prod-4" }
    });

    const result = await applyApprovedDiff({
      db: db as never,
      diffId: "diff-4",
      approvalStatus: "auto_approved"
    });

    expect(result.productVersionId).toBe("ver-existing");
    expect(result.createdVersion).toBe(false);
    expect(db._insertedVersions).toHaveLength(0);
  });
});
