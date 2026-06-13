// Catalog redesign Phase 1, Task 1.5 — pricing side tables.
//
// catalog_pricing_observations: append-only log of every observed price tier
//   from every source/channel. Partitioned monthly on observed_at; the Drizzle
//   schema is used for typed INSERT/SELECT only and intentionally does NOT
//   model partitioning or the FK on channel_id — those live in raw SQL.
//   See migrations/0011_catalog_pricing.sql for ground truth.
//
// catalog_pricing_current: latest-per-(product, channel, locale) maintained by
//   the reconciler service in TS (NOT a DB trigger). Plain table; full UPSERT
//   semantics live in application code.

import {
  pgTable,
  uuid,
  bigint,
  text,
  jsonb,
  timestamp,
  numeric,
  index,
  primaryKey
} from "drizzle-orm/pg-core";

export const catalogPricingObservations = pgTable(
  "catalog_pricing_observations",
  {
    observationId:        bigint("observation_id", { mode: "number" }).generatedByDefaultAsIdentity(),
    productId:            uuid("product_id").notNull(),
    tenantId:             uuid("tenant_id").notNull(),
    // FK to channels(channel_id) is declared in raw SQL — see migration 0011.
    channelId:            uuid("channel_id").notNull(),
    locale:               text("locale").notNull().default("_unscoped"),
    source:               text("source").notNull(),
    sourceRecordId:       text("source_record_id"),
    currency:             text("currency").notNull(),
    tiers:                jsonb("tiers").notNull(),
    pricePerUnit:         jsonb("price_per_unit"),
    observedAt:           timestamp("observed_at", { withTimezone: true }).notNull(),
    ingestedAt:           timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    artifactId:           uuid("artifact_id"),
    extras:               jsonb("extras"),
    mergedFromProductId:  uuid("merged_from_product_id")
  },
  (t) => ({
    pk:           primaryKey({ columns: [t.observationId, t.observedAt] }),
    productIdx:   index().on(t.productId, t.channelId, t.observedAt),
    tenantIdx:    index().on(t.tenantId, t.observedAt)
  })
);

export const catalogPricingCurrent = pgTable(
  "catalog_pricing_current",
  {
    productId:     uuid("product_id").notNull(),
    // Tenant scope added migration 0029 (review §2 — side/read-model tables must
    // be tenant-isolated). NOT NULL; the reconciler stamps it from the product
    // row. Indexes lead with tenant_id so per-tenant scans never cross tenants.
    tenantId:      uuid("tenant_id").notNull(),
    channelId:     uuid("channel_id").notNull(),
    locale:        text("locale").notNull().default("_unscoped"),
    source:        text("source").notNull(),
    currency:      text("currency").notNull(),
    tiers:         jsonb("tiers").notNull(),
    pricePerUnit:  jsonb("price_per_unit"),
    primaryAmount: numeric("primary_amount"),
    observedAt:    timestamp("observed_at", { withTimezone: true }).notNull()
  },
  (t) => ({
    pk:                  primaryKey({ columns: [t.productId, t.channelId, t.locale] }),
    // Tenant-leading composite indexes (migration 0029) supersede the old
    // channel-leading ones for tenant-scoped price filters/sorts.
    tenantPriceIdx:      index("idx_catalog_pricing_current_tenant_channel_price")
                           .on(t.tenantId, t.channelId, t.primaryAmount),
    tenantCurrencyIdx:   index("idx_catalog_pricing_current_tenant_channel_currency_price")
                           .on(t.tenantId, t.channelId, t.currency, t.primaryAmount)
  })
);

export type CatalogPricingObservation = typeof catalogPricingObservations.$inferSelect;
export type NewCatalogPricingObservation = typeof catalogPricingObservations.$inferInsert;
export type CatalogPricingCurrent = typeof catalogPricingCurrent.$inferSelect;
export type NewCatalogPricingCurrent = typeof catalogPricingCurrent.$inferInsert;
