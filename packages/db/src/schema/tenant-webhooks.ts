// tenant_webhooks: per-tenant webhook subscriptions consumed by the webhook
// publisher worker. One row per (tenant, URL) with an event_types[] filter and
// optional secret. The active-lookup index is partial in the migration (truth);
// Drizzle can't express the predicate, so it's declared unfiltered here.

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index
} from "drizzle-orm/pg-core";

export const tenantWebhooks = pgTable(
  "tenant_webhooks",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    tenantId:    uuid("tenant_id").notNull(),
    url:         text("url").notNull(),
    eventTypes:  text("event_types").array().notNull(),
    active:      boolean("active").notNull().default(true),
    secret:      text("secret"),
    createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    tenantIdx: index("idx_tenant_webhooks_tenant").on(t.tenantId)
  })
);

export type TenantWebhook = typeof tenantWebhooks.$inferSelect;
export type NewTenantWebhook = typeof tenantWebhooks.$inferInsert;
