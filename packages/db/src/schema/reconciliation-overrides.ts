// reconciliation_overrides: per-product manual pins on a winning value. Tenant
// scope is inherited via the catalog_products FK (ON DELETE CASCADE). Time-bounded
// pins set frozen_until; permanent pins leave it NULL.

import { pgTable, uuid, bigint, text, jsonb, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { catalogProducts } from "./catalog-products.js";

export const reconciliationOverrides = pgTable("reconciliation_overrides", {
  overrideId:    bigint("override_id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  productId:     uuid("product_id")
                   .notNull()
                   .references((): AnyPgColumn => catalogProducts.productId, { onDelete: "cascade" }),
  attributeCode: text("attribute_code").notNull(),
  channelCode:   text("channel_code").notNull(),
  localeCode:    text("locale_code").notNull().default("_unscoped"),
  frozenValue:   jsonb("frozen_value").notNull(),
  frozenUntil:   timestamp("frozen_until", { withTimezone: true }),
  actor:         text("actor").notNull(),
  rationale:     text("rationale").notNull(),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export type ReconciliationOverride = typeof reconciliationOverrides.$inferSelect;
export type NewReconciliationOverride = typeof reconciliationOverrides.$inferInsert;
