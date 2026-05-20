// Catalog redesign Phase 1 — core product table.
// catalog_products: the heart of the new catalog; every subsequent table FKs into it.
// Generated columns (search vectors, etc.) are added separately in Task 1.3 via raw SQL.

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  bigint,
  unique,
  index
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants.js";
import { merchants } from "./merchants.js";

export const catalogProducts = pgTable(
  "catalog_products",
  {
    productId:           uuid("product_id").primaryKey().defaultRandom(),
    tenantId:            uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "restrict" }),
    merchantId:          uuid("merchant_id").notNull().references(() => merchants.id, { onDelete: "restrict" }),
    parentProductId:     uuid("parent_product_id").references((): any => catalogProducts.productId),
    primaryIdentifier:   text("primary_identifier").notNull(),
    identity:            jsonb("identity").notNull(),
    family:              text("family"),
    status:              text("status").notNull().default("draft"),
    mergedIntoProductId: uuid("merged_into_product_id").references((): any => catalogProducts.productId),
    values:              jsonb("values").notNull().default(sql`'{}'::jsonb`),
    winningValues:       jsonb("winning_values"),
    winningValuesShadow: jsonb("winning_values_shadow"),
    currentRevisionId:   bigint("current_revision_id", { mode: "number" }),
    schemaVersion:       text("schema_version").notNull().default("1"),
    createdAt:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    uqTenantIdentifier: unique("uq_catalog_products_tenant_identifier").on(t.tenantId, t.primaryIdentifier),
    parentIdx:          index("idx_catalog_products_parent").on(t.parentProductId),
    tenantStatusIdx:    index("idx_catalog_products_tenant_status").on(t.tenantId, t.status),
    familyIdx:          index("idx_catalog_products_family").on(t.family)
  })
);

export type CatalogProduct = typeof catalogProducts.$inferSelect;
export type NewCatalogProduct = typeof catalogProducts.$inferInsert;
