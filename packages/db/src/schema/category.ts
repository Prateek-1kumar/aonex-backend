// HLD §9 / §20 — category_schemas.
// Seeded with 30 categories before launch (HLD §28).
// `json_schema` is the per-category JSON Schema used by the Schema Validator (Module 6).
// `marketplace_mappings` maps marketplace-native category values to this canonical path.

import {
  pgTable,
  varchar,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";

export const categorySchemas = pgTable(
  "category_schemas",
  {
    /** Slash-delimited canonical path e.g. "Apparel/Tops/T-Shirts" — HLD §20 */
    categoryPath: varchar("category_path", { length: 300 }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    /** JSON Schema object for required/optional attribute validation */
    jsonSchema: jsonb("json_schema").$type<Record<string, unknown>>().notNull(),
    requiredAttributes: text("required_attributes").array().notNull().default([]),
    optionalAttributes: text("optional_attributes").array().notNull().default([]),
    /** Variant axis definitions e.g. {Color: ["Red","Blue"], Size: ["S","M","L"]} */
    variantOptions: jsonb("variant_options").$type<Record<string, string[]>>().notNull().default({}),
    /** Maps per-marketplace category labels to this canonical path */
    marketplaceMappings: jsonb("marketplace_mappings")
      .$type<Record<string, string[]>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: uniqueIndex("uq_category_schemas_path_version").on(t.categoryPath, t.schemaVersion)
  })
);

export type CategorySchema = typeof categorySchemas.$inferSelect;
export type NewCategorySchema = typeof categorySchemas.$inferInsert;
