// Catalog redesign Phase 1 — core product table.
// catalog_products: the heart of the new catalog; every subsequent table FKs into it.
// Generated columns (search vectors, etc.) are added separately in Task 1.3 via raw SQL.

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
    // Catalog enrichment — persisted, server-authoritative quality scores (0..100).
    // Recomputed by the reconciler on winning_values change; content score set by enrichment.
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
    // Phase 4 perf — see migrations/0023_perf_indexes.sql.
    // Serves the keyset-paginated list (filter tenant+merchant, order by updated_at, product_id).
    tenantMerchantUpdatedIdx: index("idx_catalog_products_tenant_merchant_updated").on(
      t.tenantId, t.merchantId, t.updatedAt.desc(), t.productId.desc()
    ),
    // Serves the tenant-agnostic watchdog sweep (WHERE updated_at > now() - interval).
    updatedAtIdx:       index("idx_catalog_products_updated_at").on(t.updatedAt)
  })
);

export type CatalogProduct = typeof catalogProducts.$inferSelect;
export type NewCatalogProduct = typeof catalogProducts.$inferInsert;
