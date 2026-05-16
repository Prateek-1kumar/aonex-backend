// Phase 1 — Spec §16 — chunked migration of merchant_extensions_json.attributes
// → product_versions.attributes_json for already-approved versions.
//
// Idempotent: skips rows whose attributes_json is already non-empty.
// Dry-run mode returns counts without writing.
// One-shot — not registered as a cron job.

import { schema, type DrizzleClient } from "@aonex/db";
import { eq, isNull, or, sql } from "drizzle-orm";

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

  let offset = 0;
  while (true) {
    const rows = await opts.db
      .select({
        id: schema.productVersions.id,
        merchantExtensionsJson: schema.productVersions.merchantExtensionsJson,
        attributesJson: schema.productVersions.attributesJson
      })
      .from(schema.productVersions)
      .where(
        or(
          isNull(schema.productVersions.attributesJson),
          // Postgres jsonb '{}' equality requires the cast.
          sql`${schema.productVersions.attributesJson} = '{}'::jsonb`
        )
      )
      .limit(opts.chunkSize)
      .offset(offset);

    if (rows.length === 0) break;

    for (const row of rows) {
      result.examined++;

      const ext = row.merchantExtensionsJson as
        | { attributes?: Record<string, unknown>; evidence?: Record<string, unknown> }
        | null;
      const attrs = ext?.attributes;
      const existingAttrs = row.attributesJson as Record<string, unknown> | null;

      // Skip rows that already have a populated attributes_json
      if (existingAttrs && Object.keys(existingAttrs).length > 0) continue;
      // Skip rows whose merchant_extensions_json has nothing to migrate
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

    offset += rows.length;
    if (rows.length < opts.chunkSize) break;
  }

  return result;
}
