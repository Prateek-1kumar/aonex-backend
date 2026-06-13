// backfill_cursor: one row per tenant tracking resumable catalog-backfill progress.
// last_product_version_id_processed is the highest product_version id (ordered ASC)
// seen; the next batch resumes with WHERE pv.id > that value. activeIdx is partial
// (WHERE completed_at IS NULL) in the migration SQL — Drizzle can't express that, so it diverges.

import {
  pgTable,
  uuid,
  integer,
  timestamp,
  index
} from "drizzle-orm/pg-core";

export const backfillCursor = pgTable(
  "backfill_cursor",
  {
    tenantId:                       uuid("tenant_id").primaryKey(),
    lastProductVersionIdProcessed:  uuid("last_product_version_id_processed"),
    startedAt:                      timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:                      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt:                    timestamp("completed_at", { withTimezone: true }),
    totalProcessed:                 integer("total_processed").notNull().default(0),
    totalSkipped:                   integer("total_skipped").notNull().default(0),
    totalFailed:                    integer("total_failed").notNull().default(0)
  },
  (t) => ({
    activeIdx: index("idx_backfill_cursor_active").on(t.startedAt)
  })
);

export type BackfillCursor = typeof backfillCursor.$inferSelect;
export type NewBackfillCursor = typeof backfillCursor.$inferInsert;
