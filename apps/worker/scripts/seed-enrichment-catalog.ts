#!/usr/bin/env bun
// Run: bun --env-file=../../.env run scripts/seed-enrichment-catalog.ts
//
// Catalog enrichment Phase 0 — seed the typed attribute registry
// (attribute_definitions) and the DB-backed archetype schemas
// (archetype_attribute_specs) from the code catalogue in @aonex/archetypes.
//
// Idempotent: upserts by canonical_key / (archetype_id, canonical_key), so
// re-running refreshes the seed rows and never duplicates. Runtime-discovered
// attributes (origin='llm_proposed') are left untouched — they conflict on a
// different key only if a human later promotes the same canonical_key.

import { sql } from "drizzle-orm";
import { createDb, schema } from "@aonex/db";
import { allAttrDefs, listArchetypes } from "@aonex/archetypes";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const { client, close } = createDb(databaseUrl);
try {
  // 1) attribute_definitions — the typed dictionary.
  const defs = allAttrDefs();
  await client
    .insert(schema.attributeDefinitions)
    .values(
      defs.map((d) => ({
        canonicalKey: d.key,
        dataType: d.dataType,
        enumValues: d.enumValues ?? [],
        unitType: d.unitType ?? null,
        label: d.label,
        description: d.description ?? null,
        enrichmentGroup: d.group,
        appliesUniversally: d.universal ?? false,
        origin: "seed",
        status: "active",
      }))
    )
    .onConflictDoUpdate({
      target: schema.attributeDefinitions.canonicalKey,
      set: {
        dataType: sql`excluded.data_type`,
        enumValues: sql`excluded.enum_values`,
        unitType: sql`excluded.unit_type`,
        label: sql`excluded.label`,
        description: sql`excluded.description`,
        enrichmentGroup: sql`excluded.enrichment_group`,
        appliesUniversally: sql`excluded.applies_universally`,
        origin: sql`excluded.origin`,
        status: sql`excluded.status`,
      },
    });
  console.log(`Upserted ${defs.length} attribute_definitions`);

  // 2) archetype_attribute_specs — which attributes each archetype scores on.
  const archetypes = listArchetypes();
  const specRows = archetypes.flatMap((a) =>
    a.attributes.map((s) => ({
      archetypeId: a.id,
      canonicalKey: s.field,
      tier: s.tier,
      weight: String(s.weight),
      origin: "seed",
    }))
  );
  await client
    .insert(schema.archetypeAttributeSpecs)
    .values(specRows)
    .onConflictDoUpdate({
      target: [
        schema.archetypeAttributeSpecs.archetypeId,
        schema.archetypeAttributeSpecs.canonicalKey,
      ],
      set: {
        tier: sql`excluded.tier`,
        weight: sql`excluded.weight`,
        origin: sql`excluded.origin`,
      },
    });
  console.log(
    `Upserted ${specRows.length} archetype_attribute_specs across ${archetypes.length} archetypes`
  );
} catch (err) {
  console.error("Failed to seed enrichment catalogue:", err);
  process.exit(2);
} finally {
  await close();
}
