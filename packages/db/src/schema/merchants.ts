// HLD §20 — merchants belongs to a tenant.
// Auth columns (email/password_hash/display_name) are LLD-specific
// since the HLD assumes auth is "designed but not specified here".

import { pgTable, uuid, varchar, timestamp, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";

export const merchants = pgTable(
  "merchants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      // restrict — forces controlled purge per LLD §15 GDPR runbook.
      .references(() => tenants.id, { onDelete: "restrict" }),
    email: varchar("email", { length: 320 }).notNull().unique(),
    passwordHash: varchar("password_hash", { length: 200 }).notNull(),
    displayName: varchar("display_name", { length: 200 }).notNull(),
    defaultCurrency: varchar("default_currency", { length: 3 }).notNull().default("USD"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    tenantIdx: index("idx_merchants_tenant").on(t.tenantId)
  })
);

export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
