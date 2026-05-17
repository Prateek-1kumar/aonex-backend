#!/usr/bin/env bun
/**
 * Insert all seed/category-schemas/*.json files into category_schemas.
 * Top-30 paths get tier='authoritative'; rest get tier='inferred'.
 *
 * Idempotent: ON CONFLICT (category_path, schema_version) DO NOTHING.
 *
 * Usage:
 *   DATABASE_URL=... bun --bun scripts/seed/insert-category-schemas.ts
 *   DATABASE_URL=... bun --bun scripts/seed/insert-category-schemas.ts --dry-run
 *
 * Defaults to postgres://aonex:aonex@localhost:5432/aonex_dev when DATABASE_URL unset.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { schema, createDb } from "@aonex/db";

const OUT_DIR = "seed/category-schemas";
const AUTHORITATIVE_LIST_FILE = "authoritative-list.json";

const AUTHORITATIVE_LIST: string[] = JSON.parse(
  readFileSync(join(OUT_DIR, AUTHORITATIVE_LIST_FILE), "utf-8")
);

const dryRun = process.argv.includes("--dry-run");
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";

const { client: db, close } = createDb(databaseUrl);

const files = readdirSync(OUT_DIR)
  .filter((f) => f.endsWith(".json") && f !== AUTHORITATIVE_LIST_FILE);

let inserted = 0;
let skipped = 0;
let failed = 0;

try {
  for (const file of files) {
    const categoryPath = file.replace(/\.json$/, "").replace(/__/g, "/");
    const schemaDoc = JSON.parse(readFileSync(join(OUT_DIR, file), "utf-8")) as Record<string, unknown>;
    const tier = AUTHORITATIVE_LIST.includes(categoryPath) ? "authoritative" : "inferred";

    const required: string[] = Array.isArray(schemaDoc.required) ? schemaDoc.required as string[] : [];
    const properties = (schemaDoc.properties ?? {}) as Record<string, unknown>;
    const optional = Object.keys(properties).filter((k) => !required.includes(k));

    if (dryRun) {
      // eslint-disable-next-line no-console
      console.log(`[dry-run] would insert ${categoryPath} (tier=${tier}, required=${required.length}, optional=${optional.length})`);
      skipped++;
      continue;
    }

    try {
      const result = await db
        .insert(schema.categorySchemas)
        .values({
          categoryPath,
          schemaVersion: 1,
          jsonSchema: schemaDoc,
          requiredAttributes: required,
          optionalAttributes: optional,
          variantOptions: {},
          marketplaceMappings: {},
          tier,
          displayName: categoryPath.split("/").pop() ?? categoryPath,
          active: true
        })
        .onConflictDoNothing()
        .returning({ id: schema.categorySchemas.categoryPath });
      if (result.length > 0) {
        inserted++;
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      // eslint-disable-next-line no-console
      console.error(`FAILED ${categoryPath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ inserted, skipped, failed, total: files.length }, null, 2));
} finally {
  await close();
}

process.exit(failed > 0 ? 1 : 0);
