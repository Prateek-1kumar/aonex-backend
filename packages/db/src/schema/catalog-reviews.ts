// Phase 4 Task 8: normalized review records, deduped per (product_id, dedupe_key).
// catalog-service/src/reviews/normalize.ts produces rows shaped like this.

import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { catalogProducts } from "./catalog-products.js";

export const catalogReviews = pgTable(
  "catalog_reviews",
  {
    reviewId:   uuid("review_id").primaryKey().defaultRandom(),
    productId:  uuid("product_id")
      .notNull()
      .references(() => catalogProducts.productId, { onDelete: "cascade" }),
    source:     text("source").notNull(),
    author:     text("author"),
    rating:     numeric("rating", { precision: 3, scale: 2 }).notNull(),
    body:       text("body"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    dedupeKey:  text("dedupe_key").notNull(),
    createdAt:  timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    productIdx:    index("idx_catalog_reviews_product_id").on(t.productId),
    uqProductDedupe: unique("catalog_reviews_product_id_dedupe_key_key").on(
      t.productId,
      t.dedupeKey
    ),
  })
);

export type CatalogReview = typeof catalogReviews.$inferSelect;
export type NewCatalogReview = typeof catalogReviews.$inferInsert;
