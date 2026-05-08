// HLD §20 — tenants is the top of the entity hierarchy.
// "Every business table has tenant_id; merchant_id where applicable."

import { pgTable, uuid, varchar, timestamp } from "drizzle-orm/pg-core";
import { tenantStatusEnum } from "./enums.js";

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  status: tenantStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
