// Catalog redesign Phase 1, Task 1.6 — inventory side tables.
//
// catalog_inventory_observations: append-only log of every observed inventory
//   level from every source/channel/location. Partitioned monthly on
//   observed_at; the Drizzle schema is used for typed INSERT/SELECT only and
//   intentionally does NOT model partitioning, FKs, or the CHECK constraint —
//   those live in raw SQL. See migrations/0012_catalog_inventory.sql for ground truth.
//
// catalog_inventory_current: latest-per-(product, channel, location) maintained
//   by the debounced async reconciler service in TS (NOT a DB trigger). Plain
//   table; full UPSERT semantics live in application code. The PK uses a
//   STORED generated column (location_id_coalesced) to make COALESCE(location_id, sentinel)
//   participate in uniqueness — see the migration for details. Drizzle does not
//   need to model that column (same pattern as gen_* on catalog_products).

import {
  pgTable,
  uuid,
  bigint,
  text,
  integer,
  boolean,
  timestamp,
  index,
  primaryKey
} from "drizzle-orm/pg-core";

export const catalogInventoryObservations = pgTable(
  "catalog_inventory_observations",
  {
    observationId:        bigint("observation_id", { mode: "number" }).generatedByDefaultAsIdentity(),
    productId:            uuid("product_id").notNull(),
    tenantId:             uuid("tenant_id").notNull(),
    // FK to channels(channel_id) is declared in raw SQL — see migration 0012.
    channelId:            uuid("channel_id").notNull(),
    // FK to inventory_locations(location_id) is declared in raw SQL.
    locationId:           uuid("location_id"),
    qty:                  integer("qty").notNull(),
    clickCollectEligible: boolean("click_collect_eligible"),
    purchaseLimit:        integer("purchase_limit"),
    backorderAllowed:     boolean("backorder_allowed"),
    source:               text("source").notNull(),
    sourceRecordId:       text("source_record_id"),
    observedAt:           timestamp("observed_at", { withTimezone: true }).notNull(),
    ingestedAt:           timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    artifactId:           uuid("artifact_id"),
    // Added migration 0017 — set during merge to record the original (loser)
    // product so unmerge can re-attach this row. Nullable; only populated for
    // rows moved by mergeProducts (spec §18.1). No FK by design (mirrors the
    // pricing-side column).
    mergedFromProductId:  uuid("merged_from_product_id")
  },
  (t) => ({
    pk:         primaryKey({ columns: [t.observationId, t.observedAt] }),
    productIdx: index().on(t.productId, t.channelId, t.locationId, t.observedAt)
  })
);

export const catalogInventoryCurrent = pgTable(
  "catalog_inventory_current",
  {
    productId:  uuid("product_id").notNull(),
    // Tenant scope added migration 0029 (review §2 — tenant isolation on the
    // read-model tables). NOT NULL; stamped by the reconciler from the product row.
    tenantId:   uuid("tenant_id").notNull(),
    channelId:  uuid("channel_id").notNull(),
    locationId: uuid("location_id"),
    qty:        integer("qty").notNull(),
    source:     text("source").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull()
  },
  (t) => ({
    // Actual PK includes the generated location_id_coalesced column (see migration);
    // Drizzle's view of the PK here is for typed insert ergonomics only.
    pk:           primaryKey({ columns: [t.productId, t.channelId, t.locationId] }),
    // Tenant-leading (migration 0029) supersedes the old channel-leading index.
    tenantQtyIdx: index("idx_catalog_inventory_current_tenant_channel_qty")
                    .on(t.tenantId, t.channelId, t.qty)
  })
);

export type CatalogInventoryObservation = typeof catalogInventoryObservations.$inferSelect;
export type NewCatalogInventoryObservation = typeof catalogInventoryObservations.$inferInsert;
export type CatalogInventoryCurrent = typeof catalogInventoryCurrent.$inferSelect;
export type NewCatalogInventoryCurrent = typeof catalogInventoryCurrent.$inferInsert;
