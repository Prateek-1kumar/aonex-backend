#!/usr/bin/env bun
// Run: bun --bun apps/worker/scripts/run-backfill.ts [--dry-run]
//
// Phase 1 — Spec §16 — migrate merchant_extensions_json.attributes
// → attributes_json for existing approved product_versions.

import { createDb } from "@aonex/db";
import { backfillAttributesJson } from "../src/jobs/backfill-attributes-json.js";

const dryRun = process.argv.includes("--dry-run");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { client, close } = createDb(databaseUrl);
try {
  const result = await backfillAttributesJson({
    db: client,
    dryRun,
    chunkSize: 200
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length > 0) process.exit(2);
} finally {
  await close();
}
