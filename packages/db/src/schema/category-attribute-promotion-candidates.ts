// Spec §10 — populated by the schema-promotion-scan cron in Phase 3.
// Ship the table now so we don't need another migration in Phase 3.

import {
  pgTable,
  uuid,
  varchar,
  integer,
  numeric,
  timestamp,
  uniqueIndex,
  index
} from "drizzle-orm/pg-core";

export const categoryAttributePromotionCandidates = pgTable(
  "category_attribute_promotion_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    categoryPath: varchar("category_path", { length: 300 }).notNull(),
    attributeKey: varchar("attribute_key", { length: 200 }).notNull(),
    productsWithKey: integer("products_with_key").notNull().default(0),
    totalProducts: integer("total_products").notNull().default(0),
    consistencyRatio: numeric("consistency_ratio", { precision: 5, scale: 4 }).notNull().default("0"),
    status: varchar("status", { length: 20 }).notNull().default("candidate"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    uniqueCandidate: uniqueIndex("uq_promotion_candidates").on(t.categoryPath, t.attributeKey),
    statusIdx: index("idx_promotion_candidates_status").on(t.status)
  })
);

export type PromotionCandidate = typeof categoryAttributePromotionCandidates.$inferSelect;
export type NewPromotionCandidate = typeof categoryAttributePromotionCandidates.$inferInsert;
