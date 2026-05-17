// Phase 1 — Spec §16 — chunked migration of merchant_extensions_json.attributes
// → product_versions.attributes_json for already-approved versions.
//
// Idempotent: skips rows whose attributes_json is already non-empty.
// Dry-run mode returns counts without writing.
// One-shot — not registered as a cron job.

import { schema, type DrizzleClient } from "@aonex/db";
import { and, asc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";

export interface BackfillResult {
  examined: number;
  wouldUpdate: number;
  updated: number;
  errors: Array<{ id: string; error: string }>;
}

export interface BackfillOptions {
  db: DrizzleClient;
  dryRun: boolean;
  chunkSize: number;
}

export async function backfillAttributesJson(opts: BackfillOptions): Promise<BackfillResult> {
  const result: BackfillResult = {
    examined: 0,
    wouldUpdate: 0,
    updated: 0,
    errors: []
  };

  let lastId: string | null = null;
  while (true) {
    // Keyset pagination on id. Correct under self-mutating WHERE because:
    //  - Updated rows leave the eligible set, but their ids are <= lastId; cursor moved past.
    //  - Skipped rows (continue branches) stay in the set but their ids are also <= lastId
    //    after we process the chunk; cursor passes them by design (we examined them once).
    // Offset-based pagination is unsafe here — it skips rows when the result set shrinks.
    const baseFilter: SQL = or(
      isNull(schema.productVersions.attributesJson),
      sql`${schema.productVersions.attributesJson} = '{}'::jsonb`
    )!;
    const whereClause: SQL = lastId
      ? and(baseFilter, gt(schema.productVersions.id, lastId))!
      : baseFilter;

    const rows = await opts.db
      .select({
        id: schema.productVersions.id,
        merchantExtensionsJson: schema.productVersions.merchantExtensionsJson,
        attributesJson: schema.productVersions.attributesJson
      })
      .from(schema.productVersions)
      .where(whereClause)
      .orderBy(asc(schema.productVersions.id))
      .limit(opts.chunkSize);

    if (rows.length === 0) break;

    for (const row of rows) {
      result.examined++;

      const ext = row.merchantExtensionsJson as
        | { attributes?: Record<string, unknown>; evidence?: Record<string, unknown> }
        | null;
      const attrs = ext?.attributes;
      const existingAttrs = row.attributesJson as Record<string, unknown> | null;

      if (existingAttrs && Object.keys(existingAttrs).length > 0) continue;
      if (!attrs || typeof attrs !== "object" || Object.keys(attrs).length === 0) continue;

      result.wouldUpdate++;
      if (opts.dryRun) continue;

      try {
        await opts.db
          .update(schema.productVersions)
          .set({
            attributesJson: attrs,
            evidenceSummary: ext?.evidence ?? null
          })
          .where(eq(schema.productVersions.id, row.id));
        result.updated++;
      } catch (err) {
        result.errors.push({
          id: row.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    lastId = rows[rows.length - 1]!.id;
    if (rows.length < opts.chunkSize) break;
  }

  return result;
}
