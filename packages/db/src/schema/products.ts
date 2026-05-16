// HLD §8 / §20 — products, product_identities, product_versions,
// product_variants, product_variant_versions.
//
// product_versions are IMMUTABLE (HLD §8.3): a Postgres trigger in
// src/sql/triggers.sql blocks UPDATE/DELETE. To change System Truth,
// create a proposed_diff and approve it.
//
// product_versions.proposed_diff_id is NOT NULL — enforced here and
// double-enforced by a trigger that checks diff status ∈ {approved, auto_approved}.

import {
  pgTable,
  uuid,
  varchar,
  numeric,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  index
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { merchants } from "./merchants.js";
import { proposedDiffs } from "./proposed-diffs.js";
import { productStatusEnum } from "./enums.js";

/**
 * HLD §8 / §20 — canonical product aggregate root.
 * current_version_id is updated (the only mutable field on product_versions'
 * companion) when a new approved version is created.
 */
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    /** Updated to point at the latest approved version */
    currentVersionId: uuid("current_version_id"),
    status: productStatusEnum("status").notNull().default("draft"),
    canonicalCategory: varchar("canonical_category", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    tenantIdx: index("idx_products_tenant").on(t.tenantId, t.merchantId),
    statusIdx: index("idx_products_status").on(t.tenantId, t.status)
  })
);

/**
 * HLD §13 / §20 — product identity records for deduplication.
 * UNIQUE on (tenant_id, identity_type, identity_value) — one canonical
 * product per GTIN per tenant.
 */
export const productIdentities = pgTable(
  "product_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull(),
    /** "gtin" | "mpn" | "sku" | "brand_mpn" */
    identityType: varchar("identity_type", { length: 30 }).notNull(),
    identityValue: varchar("identity_value", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    uniqueIdentity: uniqueIndex("uq_product_identities").on(
      t.tenantId,
      t.identityType,
      t.identityValue
    )
  })
);

/**
 * HLD §8.3 / §20 — immutable product version snapshot.
 * NEVER UPDATE OR DELETE — Postgres trigger enforces this.
 * proposed_diff_id NOT NULL: every version must trace to an approved diff (HLD §2.4).
 */
export const productVersions = pgTable(
  "product_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    tenantId: uuid("tenant_id").notNull(),
    merchantId: uuid("merchant_id").notNull(),
    proposedDiffId: uuid("proposed_diff_id")
      .notNull()
      .references(() => proposedDiffs.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 500 }).notNull(),
    brand: varchar("brand", { length: 200 }),
    gtin: varchar("gtin", { length: 30 }),
    gtinType: varchar("gtin_type", { length: 10 }),
    modelNumber: varchar("model_number", { length: 100 }),
    manufacturerPartNumber: varchar("manufacturer_part_number", { length: 100 }),
    basePrice: numeric("base_price", { precision: 12, scale: 4 }),
    currency: varchar("currency", { length: 3 }),
    weightGrams: numeric("weight_grams", { precision: 12, scale: 3 }),
    dimensionsCm: jsonb("dimensions_cm").$type<{ l?: number; w?: number; h?: number }>(),
    images: jsonb("images").$type<Array<{ url: string; altText?: string }>>(),
    description: text("description"),
    canonicalCategory: varchar("canonical_category", { length: 300 }),
    categorySchemaVersion: varchar("category_schema_version", { length: 50 }),
    categoryConfidence: numeric("category_confidence", { precision: 5, scale: 4 }),
    attributesJson: jsonb("attributes_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 4 }).notNull(),
    schemaVersion: varchar("schema_version", { length: 20 }).notNull().default("1"),
    merchantExtensionsJson: jsonb("merchant_extensions_json").$type<Record<string, unknown>>(),
    evidenceSummary: jsonb("evidence_summary").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    productIdx: index("idx_product_versions_product").on(t.productId),
    diffIdx: index("idx_product_versions_diff").on(t.proposedDiffId),
    createdIdx: index("idx_product_versions_created").on(t.tenantId, t.createdAt),
    attrsGinIdx: index("idx_product_versions_attrs_gin").using("gin", t.attributesJson),
    categoryIdx: index("idx_product_versions_category").on(t.canonicalCategory)
  })
);

/**
 * HLD §8 / §20 — variant aggregate (color/size/etc combinations).
 * variant_key is a deterministic hash of normalized axis values
 * so the same combination is stable across syncs.
 */
export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    tenantId: uuid("tenant_id").notNull(),
    currentVariantVersionId: uuid("current_variant_version_id"),
    /** Deterministic hash of sorted normalized variant axis values */
    variantKey: varchar("variant_key", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    productVariantKey: uniqueIndex("uq_product_variants_key").on(t.productId, t.variantKey)
  })
);

/**
 * HLD §8 / §20 — immutable variant version snapshot.
 * variant_axes: e.g. {Color: "Red", Size: "M"}
 */
export const productVariantVersions = pgTable(
  "product_variant_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    productVersionId: uuid("product_version_id")
      .notNull()
      .references(() => productVersions.id, { onDelete: "restrict" }),
    tenantId: uuid("tenant_id").notNull(),
    sku: varchar("sku", { length: 200 }),
    barcode: varchar("barcode", { length: 100 }),
    price: numeric("price", { precision: 12, scale: 4 }),
    currency: varchar("currency", { length: 3 }),
    inventoryQuantity: numeric("inventory_quantity", { precision: 12, scale: 0 }),
    /** Canonical variant axes e.g. {Color: "Red", Size: "M"} */
    variantAxes: jsonb("variant_axes").$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    variantIdx: index("idx_product_variant_versions_variant").on(t.variantId),
    productVersionIdx: index("idx_product_variant_versions_pv").on(t.productVersionId)
  })
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type ProductIdentity = typeof productIdentities.$inferSelect;
export type NewProductIdentity = typeof productIdentities.$inferInsert;
export type ProductVersion = typeof productVersions.$inferSelect;
export type NewProductVersion = typeof productVersions.$inferInsert;
export type ProductVariant = typeof productVariants.$inferSelect;
export type NewProductVariant = typeof productVariants.$inferInsert;
export type ProductVariantVersion = typeof productVariantVersions.$inferSelect;
export type NewProductVariantVersion = typeof productVariantVersions.$inferInsert;
