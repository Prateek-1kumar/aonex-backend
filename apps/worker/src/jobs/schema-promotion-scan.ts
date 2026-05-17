import { schema, type DrizzleClient } from "@aonex/db";
import { sql } from "drizzle-orm";
import type { CronJob } from "./index.js";

export interface PromotionThresholds {
  minProducts: number;
  minKeys: number;
  minConsistency: number;
}

export interface PromotionScanResult {
  examined: number;
  proposedDrafts: number;
  errors: Array<{ categoryPath: string; error: string }>;
}

export const DEFAULT_THRESHOLDS: PromotionThresholds = {
  minProducts: 50,
  minKeys: 8,
  minConsistency: 0.8
};

/**
 * Spec section 10 — nightly cron. Aggregates attributes_json keys across
 * product_versions grouped by canonical_category. When thresholds are met
 * AND no Tier 1 authoritative schema exists for the path, inserts a
 * tier='promoted_draft' row into category_schemas for admin review.
 */
export async function runSchemaPromotionScan(input: {
  db: DrizzleClient;
  thresholds?: PromotionThresholds;
}): Promise<PromotionScanResult> {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const result: PromotionScanResult = { examined: 0, proposedDrafts: 0, errors: [] };

  // Aggregate via raw SQL — jsonb_object_keys is awkward through Drizzle's query builder.
  const rows = await input.db.execute(sql`
    SELECT
      canonical_category,
      count(*) AS total_products,
      jsonb_object_agg(k, freq) AS attribute_distributions
    FROM (
      SELECT
        canonical_category,
        k,
        count(*) AS freq
      FROM product_versions, jsonb_object_keys(attributes_json) AS k
      WHERE canonical_category IS NOT NULL
        AND attributes_json IS NOT NULL
        AND attributes_json != '{}'::jsonb
      GROUP BY canonical_category, k
    ) sub
    GROUP BY canonical_category
  `);

  for (const row of rows as unknown as Array<{
    canonical_category: string;
    total_products: number;
    attribute_distributions: Record<string, number>;
  }>) {
    result.examined++;
    const totalProducts = Number(row.total_products);
    if (totalProducts < thresholds.minProducts) continue;

    const consistentKeys = Object.entries(row.attribute_distributions)
      .filter(([, freq]) => Number(freq) / totalProducts >= thresholds.minConsistency)
      .map(([k]) => k);

    if (consistentKeys.length < thresholds.minKeys) continue;

    const existing = await input.db.query.categorySchemas.findFirst({
      where: (c, { and, eq }) =>
        and(eq(c.categoryPath, row.canonical_category), eq(c.tier, "authoritative"))
    });
    if (existing) continue;

    try {
      await input.db
        .insert(schema.categorySchemas)
        .values({
          categoryPath: row.canonical_category,
          schemaVersion: 1,
          jsonSchema: {
            $schema: "https://json-schema.org/draft/2019-09/schema",
            $id: `category_schemas/${row.canonical_category.replace(/\//g, "_")}/v1_draft`,
            type: "object",
            tier: "promoted_draft",
            required: consistentKeys,
            properties: Object.fromEntries(consistentKeys.map((k) => [k, {}])),
            additionalProperties: true
          },
          requiredAttributes: consistentKeys,
          optionalAttributes: [],
          variantOptions: {},
          marketplaceMappings: {},
          tier: "promoted_draft",
          displayName: row.canonical_category.split("/").pop() ?? row.canonical_category,
          active: false
        })
        .onConflictDoNothing();
      result.proposedDrafts++;
    } catch (err) {
      result.errors.push({
        categoryPath: row.canonical_category,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return result;
}

export const schemaPromotionScan: CronJob = {
  name: "schema-promotion-scan",
  cronSchedule: "0 3 * * *",   // nightly at 03:00 UTC
  async process({ db }) {
    await runSchemaPromotionScan({ db });
  },
};
