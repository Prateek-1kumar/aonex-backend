// HLD §4.5 / spec §4.5 — localized display names per category_path.
// Codes are immutable; labels translate.

import {
  pgTable,
  varchar,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";

export const categoryLabels = pgTable(
  "category_labels",
  {
    categoryPath: varchar("category_path", { length: 300 }).notNull(),
    locale: varchar("locale", { length: 10 }).notNull(),
    displayName: varchar("display_name", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: uniqueIndex("uq_category_labels").on(t.categoryPath, t.locale)
  })
);

export type CategoryLabel = typeof categoryLabels.$inferSelect;
export type NewCategoryLabel = typeof categoryLabels.$inferInsert;
