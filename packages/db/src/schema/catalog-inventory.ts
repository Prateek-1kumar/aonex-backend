// Inventory side tables: catalog_inventory_observations (append-only log) and
// catalog_inventory_current (latest-per-product/channel/location, maintained by the
// reconciler in TS, not a DB trigger). Drizzle defs are for typed INSERT/SELECT only;
// partitioning, FKs, CHECKs, and the current PK's generated coalesce column live in SQL.

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
    channelId:            uuid("channel_id").notNull(),
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
    /** Set during merge to the original (loser) product so unmerge can re-attach this row. No FK by design. */
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
    tenantId:   uuid("tenant_id").notNull(),
    channelId:  uuid("channel_id").notNull(),
    locationId: uuid("location_id"),
    qty:        integer("qty").notNull(),
    source:     text("source").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull()
  },
  (t) => ({
    pk:           primaryKey({ columns: [t.productId, t.channelId, t.locationId] }),
    tenantQtyIdx: index("idx_catalog_inventory_current_tenant_channel_qty")
                    .on(t.tenantId, t.channelId, t.qty)
  })
);

export type CatalogInventoryObservation = typeof catalogInventoryObservations.$inferSelect;
export type NewCatalogInventoryObservation = typeof catalogInventoryObservations.$inferInsert;
export type CatalogInventoryCurrent = typeof catalogInventoryCurrent.$inferSelect;
export type NewCatalogInventoryCurrent = typeof catalogInventoryCurrent.$inferInsert;
