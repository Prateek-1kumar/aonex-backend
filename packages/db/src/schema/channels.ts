// Catalog redesign Phase 1 — registry tables.
// channels: represents a sales channel (Shopify, Amazon, etc.) for a tenant.
// inventory_locations: physical or virtual locations attached to a channel.

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

export const channels = pgTable(
  "channels",
  {
    channelId:       uuid("channel_id").primaryKey().defaultRandom(),
    tenantId:        uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    channelKind:     text("channel_kind").notNull(),
    region:          text("region"),
    accountRef:      text("account_ref"),
    defaultCurrency: text("default_currency"),
    defaultLocale:   text("default_locale"),
    displayName:     text("display_name").notNull(),
    createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    uniqueChannel: uniqueIndex("uq_channels").on(t.tenantId, t.channelKind, t.region, t.accountRef),
    tenantIdx:     index("idx_channels_tenant").on(t.tenantId)
  })
);

export const inventoryLocations = pgTable(
  "inventory_locations",
  {
    locationId:  uuid("location_id").primaryKey().defaultRandom(),
    channelId:   uuid("channel_id").notNull().references(() => channels.channelId, { onDelete: "cascade" }),
    tenantId:    uuid("tenant_id").notNull(),
    kind:        text("kind").notNull(), // 'warehouse' | 'store' | 'fba' | 'dropship'
    externalRef: text("external_ref"),
    geo:         jsonb("geo"),
    displayName: text("display_name").notNull(),
    createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    channelIdx: index("idx_inv_locations_channel").on(t.channelId)
  })
);

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
export type InventoryLocation = typeof inventoryLocations.$inferSelect;
export type NewInventoryLocation = typeof inventoryLocations.$inferInsert;
