// attribute_definitions, attribute_synonyms, attribute_mappings,
// attribute_embeddings, mapping_overrides: the semantic mapper's lookup corpus.

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
 * Canonical attribute catalogue.
 * One row per recognized attribute key (e.g. "product.brand").
 */
export const attributeDefinitions = pgTable(
  "attribute_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Dotted canonical key — unique across the system. */
    canonicalKey: varchar("canonical_key", { length: 200 }).notNull(),
    /** One of: string|number|boolean|array|object. */
    dataType: varchar("data_type", { length: 32 }).notNull(),
    /** e.g. mass|length|currency. */
    unitType: varchar("unit_type", { length: 50 }),
    canonicalUnit: varchar("canonical_unit", { length: 30 }),
    allowedUnits: text("allowed_units").array().notNull().default([]),
    enumValues: text("enum_values").array().notNull().default([]),
    /** Categories this attribute is scoped to; empty = global. */
    categoryScope: text("category_scope").array().notNull().default([]),
    isVariantOption: boolean("is_variant_option").notNull().default(false),
    validationJson: jsonb("validation_json").$type<Record<string, unknown>>(),
    /** Weight used in the policy engine identity_score sub-calculation. */
    confidenceWeight: numeric("confidence_weight", { precision: 4, scale: 3 })
      .notNull()
      .default("1.000"),
    label: text("label"),
    description: text("description"),
    /** descriptive | occasion | care | marketing | seo | aeo | category. */
    enrichmentGroup: varchar("enrichment_group", { length: 32 }),
    /** true = applies to all archetypes (marketing/seo/aeo/category groups). */
    appliesUniversally: boolean("applies_universally").notNull().default(false),
    /** seed | llm_proposed. */
    origin: varchar("origin", { length: 20 }).notNull().default("seed"),
    /** active | candidate | deprecated. */
    status: varchar("status", { length: 20 }).notNull().default("active"),
    proposedFromProductId: uuid("proposed_from_product_id"),
    /** Which external standard(s) this attribute/value-set was sourced or merged from. */
    provenance: jsonb("provenance").$type<{ sources?: { system: string; ref?: string }[] }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    canonicalKeyUnique: uniqueIndex("uq_attribute_definitions_key").on(t.canonicalKey)
  })
);

/**
 * Per-marketplace synonyms for canonical keys.
 * Synonym match step: look up raw_key here → get canonicalKey.
 */
export const attributeSynonyms = pgTable(
  "attribute_synonyms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    canonicalKey: varchar("canonical_key", { length: 200 }).notNull(),
    /** The raw marketplace field name, e.g. "Marque" for French Shopify stores. */
    synonym: varchar("synonym", { length: 200 }).notNull(),
    sourceMarketplace: varchar("source_marketplace", { length: 50 }),
    source: varchar("source", { length: 20 }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    synonymIdx: index("idx_attribute_synonyms_synonym").on(t.synonym),
    canonicalIdx: index("idx_attribute_synonyms_canonical").on(t.canonicalKey)
  })
);

/**
 * Deterministic channel mappings.
 * Exact lookup: (marketplace, category_path, source_path) → canonical_key.
 * The highest-confidence mapping step (weight 0.40).
 */
export const attributeMappings = pgTable(
  "attribute_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketplace: varchar("marketplace", { length: 50 }).notNull(),
    categoryPath: varchar("category_path", { length: 300 }).notNull(),
    /** JSONPath into the raw artifact, e.g. "$.vendor". */
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
 * Embedding vectors for semantic mapping. The vector column is not modeled here;
 * it requires the pgvector extension and is added via raw SQL.
 */
export const attributeEmbeddings = pgTable(
  "attribute_embeddings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    canonicalKey: varchar("canonical_key", { length: 200 }).notNull(),
    modelVersion: varchar("model_version", { length: 50 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    keyIdx: index("idx_attribute_embeddings_key").on(t.canonicalKey)
  })
);

/**
 * Per-tenant/merchant overrides for canonical mappings.
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
