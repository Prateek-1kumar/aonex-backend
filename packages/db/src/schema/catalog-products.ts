// catalog_products: the core catalog table; most other tables FK into it.
// Generated columns (search vectors, etc.) are added separately via raw SQL.

import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  integer,
  numeric,
  timestamp,
  bigint,
  unique,
  index,
  type AnyPgColumn
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
    parentProductId:     uuid("parent_product_id").references((): AnyPgColumn => catalogProducts.productId),
    primaryIdentifier:   text("primary_identifier").notNull(),
    identity:            jsonb("identity").notNull(),
    family:              text("family"),
    /** FK into taxonomy_nodes (declared in SQL migration); nullable until the classifier sets it. */
    categoryNodeId:      text("category_node_id"),
    /** How category_node_id was set: 'auto' (classifier) or 'human' (Lab); 'human' is sticky and never overwritten. */
    categorySource:      text("category_source"),
    status:              text("status").notNull().default("draft"),
    mergedIntoProductId: uuid("merged_into_product_id").references((): AnyPgColumn => catalogProducts.productId),
    values:              jsonb("values").notNull().default(sql`'{}'::jsonb`),
    winningValues:       jsonb("winning_values"),
    winningValuesShadow: jsonb("winning_values_shadow"),
    currentRevisionId:   bigint("current_revision_id", { mode: "number" }),
    schemaVersion:       text("schema_version").notNull().default("1"),
    identifiers:         jsonb("identifiers").notNull().default(sql`'[]'::jsonb`),
    identifierExists:    boolean("identifier_exists").notNull().default(true),
    pipelineVersion:     integer("pipeline_version").notNull().default(1),
    /** Server-authoritative quality score (0..100); recomputed by the reconciler on winning_values change. */
    completenessScore:   numeric("completeness_score", { precision: 5, scale: 2 }),
    contentQualityScore: numeric("content_quality_score", { precision: 5, scale: 2 }),
    scoreBreakdown:      jsonb("score_breakdown"),
    createdAt:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    uqTenantIdentifier: unique("uq_catalog_products_tenant_identifier").on(t.tenantId, t.primaryIdentifier),
    parentIdx:          index("idx_catalog_products_parent").on(t.parentProductId),
    tenantStatusIdx:    index("idx_catalog_products_tenant_status").on(t.tenantId, t.status),
    familyIdx:          index("idx_catalog_products_family").on(t.family),
    categoryNodeIdx:    index("idx_catalog_products_category_node").on(t.categoryNodeId),
    tenantMerchantUpdatedIdx: index("idx_catalog_products_tenant_merchant_updated").on(
      t.tenantId, t.merchantId, t.updatedAt.desc(), t.productId.desc()
    ),
    updatedAtIdx:       index("idx_catalog_products_updated_at").on(t.updatedAt)
  })
);

export type CatalogProduct = typeof catalogProducts.$inferSelect;
export type NewCatalogProduct = typeof catalogProducts.$inferInsert;
