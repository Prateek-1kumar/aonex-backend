// Catalog redesign Phase 5, Task 5.7 — tenant_webhooks (webhook consumer v1).
//
// Per-tenant webhook subscriptions consumed by the webhook publisher worker
// (apps/worker/src/jobs/webhook-publisher.ts). The shape is intentionally
// small for v1: one row per (tenant, URL), `event_types[]` filter, optional
// `secret` reserved for v2 HMAC signing.
//
// The migration is the ground truth — see migrations/0018_tenant_webhooks.sql.
// Drizzle does not model the partial-on-active lookup index; that lives in
// the SQL migration.

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
    // Partial WHERE active=true is in the migration; Drizzle can't model the
    // predicate, but declaring the index here keeps query-builder hints right.
    tenantIdx: index("idx_tenant_webhooks_tenant").on(t.tenantId)
  })
);

export type TenantWebhook = typeof tenantWebhooks.$inferSelect;
export type NewTenantWebhook = typeof tenantWebhooks.$inferInsert;
