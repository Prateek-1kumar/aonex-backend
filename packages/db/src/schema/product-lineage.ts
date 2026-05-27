// Catalog redesign Phase 1, Task 1.9 — product_lineage table.
//
// Append-only history of merge/split/unmerge operations between products.
// Both FKs (product_id, origin_product_id) point at catalog_products with
// no ON DELETE clause — NO ACTION default — because lineage outlives merges
// by design.
//
// Two named indexes on (product_id) and (origin_product_id) for fast lookups
// in both directions.
//
// Drizzle schema is used for INSERT/SELECT typing only; the migration is the
// ground truth — see migrations/0015_reconciliation_overrides_and_lineage.sql.

import { pgTable, uuid, bigint, text, jsonb, timestamp, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { catalogProducts } from "./catalog-products.js";

export const productLineage = pgTable(
  "product_lineage",
  {
    lineageId:       bigint("lineage_id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    productId:       uuid("product_id").notNull().references((): AnyPgColumn => catalogProducts.productId),
    originProductId: uuid("origin_product_id").notNull().references((): AnyPgColumn => catalogProducts.productId),
    operation:       text("operation").notNull(),  // 'merge' | 'split' | 'unmerge'
    splitFilter:     jsonb("split_filter"),        // present for 'split'
    rationale:       text("rationale"),
    actor:           text("actor").notNull(),
    occurredAt:      timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    productIdx: index("idx_product_lineage_product").on(t.productId),
    originIdx:  index("idx_product_lineage_origin").on(t.originProductId)
  })
);

export type ProductLineage = typeof productLineage.$inferSelect;
export type NewProductLineage = typeof productLineage.$inferInsert;
