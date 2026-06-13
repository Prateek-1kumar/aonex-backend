// product_lineage: append-only history of merge/split/unmerge operations between
// products. Both FKs use the NO ACTION default (no ON DELETE) so lineage outlives
// merges by design.

import { pgTable, uuid, bigint, text, jsonb, timestamp, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { catalogProducts } from "./catalog-products.js";

export const productLineage = pgTable(
  "product_lineage",
  {
    lineageId:       bigint("lineage_id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    productId:       uuid("product_id").notNull().references((): AnyPgColumn => catalogProducts.productId),
    originProductId: uuid("origin_product_id").notNull().references((): AnyPgColumn => catalogProducts.productId),
    operation:       text("operation").notNull(),
    splitFilter:     jsonb("split_filter"),
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
