import {
  pgTable,
  uuid,
  varchar,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const priceClusters = pgTable(
  "price_clusters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    brand: varchar("brand", { length: 200 }).notNull(),
    canonicalCategory: varchar("canonical_category", { length: 300 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    medianPrice: numeric("median_price", { precision: 12, scale: 4 }).notNull(),
    sampleCount: integer("sample_count").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex("uq_price_clusters").on(
      t.tenantId,
      t.brand,
      t.canonicalCategory,
      t.currency
    ),
  })
);

export type PriceCluster = typeof priceClusters.$inferSelect;
export type NewPriceCluster = typeof priceClusters.$inferInsert;
