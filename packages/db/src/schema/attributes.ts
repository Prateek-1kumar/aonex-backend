// HLD §10 / §20 — attribute_definitions, attribute_synonyms,
// attribute_mappings, attribute_embeddings, mapping_overrides.
// These tables are the semantic mapper's lookup corpus.

import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  jsonb,
  numeric,
  timestamp,
  integer,
  uniqueIndex,
  index
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { merchants } from "./merchants.js";

/**
 * HLD §10 / §20 — canonical attribute catalogue.
 * One row per recognized attribute key (e.g. "product.brand").
 */
export const attributeDefinitions = pgTable(
  "attribute_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Dotted canonical key — unique across the system */
    canonicalKey: varchar("canonical_key", { length: 200 }).notNull(),
    dataType: varchar("data_type", { length: 32 }).notNull(), // string|number|boolean|array|object
    unitType: varchar("unit_type", { length: 50 }), // mass|length|currency|...
    canonicalUnit: varchar("canonical_unit", { length: 30 }),
    allowedUnits: text("allowed_units").array().notNull().default([]),
    enumValues: text("enum_values").array().notNull().default([]),
    /** Categories this attribute is scoped to; empty = global */
    categoryScope: text("category_scope").array().notNull().default([]),
    isVariantOption: boolean("is_variant_option").notNull().default(false),
    validationJson: jsonb("validation_json").$type<Record<string, unknown>>(),
    /** Weight used in the policy engine identity_score sub-calculation */
    confidenceWeight: numeric("confidence_weight", { precision: 4, scale: 3 })
      .notNull()
      .default("1.000"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    canonicalKeyUnique: uniqueIndex("uq_attribute_definitions_key").on(t.canonicalKey)
  })
);

/**
 * HLD §10 / §20 — per-marketplace synonyms for canonical keys.
 * Synonym match step: look up raw_key here → get canonicalKey.
 */
export const attributeSynonyms = pgTable(
  "attribute_synonyms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    canonicalKey: varchar("canonical_key", { length: 200 }).notNull(),
    /** The raw marketplace field name, e.g. "Marque" for French Shopify stores */
    synonym: varchar("synonym", { length: 200 }).notNull(),
    sourceMarketplace: varchar("source_marketplace", { length: 50 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    synonymIdx: index("idx_attribute_synonyms_synonym").on(t.synonym),
    canonicalIdx: index("idx_attribute_synonyms_canonical").on(t.canonicalKey)
  })
);

/**
 * HLD §10 / §20 — deterministic channel mappings.
 * Exact lookup: (marketplace, category_path, source_path) → canonical_key.
 * This is the highest-confidence mapping step (weight 0.40).
 */
export const attributeMappings = pgTable(
  "attribute_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketplace: varchar("marketplace", { length: 50 }).notNull(),
    categoryPath: varchar("category_path", { length: 300 }).notNull(),
    /** JSONPath into the raw artifact, e.g. "$.vendor" */
    sourcePath: varchar("source_path", { length: 300 }).notNull(),
    canonicalKey: varchar("canonical_key", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    lookupIdx: uniqueIndex("uq_attribute_mappings_lookup").on(
      t.marketplace,
      t.categoryPath,
      t.sourcePath
    )
  })
);

/**
 * HLD §10 / §28 — embedding vectors for semantic mapping.
 * Column is NULLABLE — Phase 3+ only. pgvector extension required.
 * See docs/adr/ADR-006 for the open pgvector decision.
 */
export const attributeEmbeddings = pgTable(
  "attribute_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    canonicalKey: varchar("canonical_key", { length: 200 }).notNull(),
    // TODO: pgvector — Phase 3: change to vector(1536) once pgvector is enabled.
    // embedding: vector("embedding", { dimensions: 1536 }),
    modelVersion: varchar("model_version", { length: 50 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    keyIdx: index("idx_attribute_embeddings_key").on(t.canonicalKey)
  })
);

/**
 * HLD §10 / §20 — per-tenant/merchant overrides for canonical mappings.
 * Higher priority than the global attribute_mappings table.
 */
export const mappingOverrides = pgTable(
  "mapping_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    merchantId: uuid("merchant_id")
      .references(() => merchants.id, { onDelete: "cascade" }),
    sourceKey: varchar("source_key", { length: 200 }).notNull(),
    canonicalKey: varchar("canonical_key", { length: 200 }).notNull(),
    priority: integer("priority").notNull().default(100),
    domainPattern: varchar("domain_pattern", { length: 200 }),
    normalizationRule: jsonb("normalization_rule").$type<Record<string, unknown>>(),
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    promoteEligibleAt: timestamp("promote_eligible_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    sourceReviewTaskId: uuid("source_review_task_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    tenantSourceIdx: index("idx_mapping_overrides_tenant_source").on(t.tenantId, t.sourceKey),
    scopeIdx: index("idx_mapping_overrides_scope").on(t.tenantId, t.domainPattern, t.sourceKey)
  })
);

export type AttributeDefinition = typeof attributeDefinitions.$inferSelect;
export type AttributeSynonym = typeof attributeSynonyms.$inferSelect;
export type AttributeMapping = typeof attributeMappings.$inferSelect;
export type MappingOverride = typeof mappingOverrides.$inferSelect;
