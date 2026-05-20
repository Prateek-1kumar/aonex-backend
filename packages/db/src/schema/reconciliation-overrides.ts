// Catalog redesign Phase 1, Task 1.9 — reconciliation_overrides table.
//
// Per-product manual pins on a winning value. Tenant scope is inherited via
// the catalog_products FK. Time-bounded pins set frozen_until; permanent pins
// leave it NULL. ON DELETE CASCADE on product_id — a product's pins go away
// with the product.
//
// Drizzle schema is used for INSERT/SELECT typing only; the migration is the
// ground truth — see migrations/0015_reconciliation_overrides_and_lineage.sql.

import { pgTable, uuid, bigint, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { catalogProducts } from "./catalog-products.js";

export const reconciliationOverrides = pgTable("reconciliation_overrides", {
  overrideId:    bigint("override_id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  productId:     uuid("product_id")
                   .notNull()
                   .references((): any => catalogProducts.productId, { onDelete: "cascade" }),
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
