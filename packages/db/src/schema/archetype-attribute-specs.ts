// archetype_attribute_specs: maps an archetype (catalog_products.family) to the
// attributes that matter for it, with tier + weight. DB-backed so the schema can
// grow at runtime when a human accepts an LLM-discovered attribute; the in-memory
// @aonex/archetypes registry is a cache hydrated from this table.

import { pgTable, text, numeric, timestamp, primaryKey, index } from "drizzle-orm/pg-core";

export const archetypeAttributeSpecs = pgTable(
  "archetype_attribute_specs",
  {
    archetypeId:  text("archetype_id").notNull(),
    /** by-value reference to attribute_definitions.canonical_key */
    canonicalKey: text("canonical_key").notNull(),
    /** required | recommended | optional */
    tier:         text("tier").notNull(),
    weight:       numeric("weight", { precision: 4, scale: 3 }).notNull().default("0.500"),
    /** seed | llm_proposed */
    origin:       text("origin").notNull().default("seed"),
    createdAt:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk:          primaryKey({ columns: [t.archetypeId, t.canonicalKey] }),
    archetypeIdx: index("idx_archetype_attr_specs_archetype").on(t.archetypeId)
  })
);

export type ArchetypeAttributeSpec = typeof archetypeAttributeSpecs.$inferSelect;
export type NewArchetypeAttributeSpec = typeof archetypeAttributeSpecs.$inferInsert;
