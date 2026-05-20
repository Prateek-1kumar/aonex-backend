// Catalog redesign Phase 1, Task 1.8 — identity_log audit table.
//
// Append-only log of changes to product identity fields (gtin, mpn, brand,
// model_number, ...). Low-velocity, simple single-column PK — no partitioning.
// Every row records a single field-level transition with the source that
// triggered it and an optional rationale.
//
// Drizzle schema is used for INSERT/SELECT typing only; the migration is the
// ground truth — see migrations/0014_identity_log.sql.

import { pgTable, uuid, bigint, text, timestamp } from "drizzle-orm/pg-core";
import { catalogProducts } from "./catalog-products.js";

export const identityLog = pgTable("identity_log", {
  logId:          bigint("log_id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  productId:      uuid("product_id").notNull().references(() => catalogProducts.productId),
  tenantId:       uuid("tenant_id").notNull(),
  identityField:  text("identity_field").notNull(),
  oldValue:       text("old_value"),
  newValue:       text("new_value"),
  source:         text("source").notNull(),
  sourceRecordId: text("source_record_id"),
  observedAt:     timestamp("observed_at", { withTimezone: true }).notNull(),
  appliedAt:      timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  rationale:      text("rationale")
});

export type IdentityLog = typeof identityLog.$inferSelect;
export type NewIdentityLog = typeof identityLog.$inferInsert;
