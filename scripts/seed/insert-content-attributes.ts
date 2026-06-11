#!/usr/bin/env bun
/**
 * insert-content-attributes.ts — register the UNIVERSAL CONTENT LAYER in
 * attribute_definitions (applies_universally = true).
 *
 * The taxonomy migration kept only the Shopify-sourced STRUCTURED specs. The
 * content/SEO/marketing/AEO attributes (description, key_features, meta_title,
 * seo_keywords, faq, …) live as the code source of truth in
 * @aonex/taxonomy-schema (CONTENT_ATTRIBUTES). The enrichment engine merges them
 * into every leaf from code; this seed mirrors them into the DB so the Lab,
 * grouping, and attribute-promotion infra can see them.
 *
 * Idempotent: upserts by canonical_key.
 *
 * Usage:
 *   DATABASE_URL=... bun scripts/seed/insert-content-attributes.ts
 *   bun scripts/seed/insert-content-attributes.ts --dry-run
 */
import { schema, createDb } from "@aonex/db";
import { contentAttributeDefs } from "@aonex/taxonomy-schema";

const dryRun = process.argv.includes("--dry-run");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://aonex:aonex@localhost:5432/aonex_dev";

const rows = contentAttributeDefs();

if (dryRun) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ dryRun: true, contentAttributes: rows.length, keys: rows.map((r) => r.canonicalKey) }, null, 2));
  process.exit(0);
}

const { client: db, close } = createDb(databaseUrl);
try {
  for (const r of rows) {
    await db
      .insert(schema.attributeDefinitions)
      .values(r)
      .onConflictDoUpdate({
        target: schema.attributeDefinitions.canonicalKey,
        set: {
          label: r.label,
          dataType: r.dataType,
          enrichmentGroup: r.enrichmentGroup,
          appliesUniversally: r.appliesUniversally,
          description: r.description,
          validationJson: r.validationJson,
          provenance: r.provenance,
        },
      });
  }
  // eslint-disable-next-line no-console
  console.log(`content attributes upserted: ${rows.length}`);
} finally {
  await close();
}
