// Catalog redesign Phase 7, Task 7.1 — backfill_cursor schema.
//
// One row per tenant; tracks resumable progress of the catalog backfill
// script (`apps/worker/scripts/backfill-catalog.ts`).
//
// last_product_version_id_processed is the highest product_version UUID
// seen so far (ordered by id ASC). The next batch query uses
//   WHERE pv.id > last_product_version_id_processed
// to resume without re-processing already-handled rows.

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
    // Note: the migration SQL declares this as a partial index with
    // WHERE completed_at IS NULL (so only active/in-progress cursors are
    // indexed). Drizzle ORM does not support partial index WHERE predicates
    // in this version of drizzle-orm/pg-core — the .where() API is not
    // available on IndexBuilder. The migration SQL is the source of truth;
    // this Drizzle definition is used for SELECT typing only and diverges
    // intentionally. Do not add .where() here without first verifying it
    // is available in the project's drizzle-orm version.
    activeIdx: index("idx_backfill_cursor_active").on(t.startedAt)
  })
);

export type BackfillCursor = typeof backfillCursor.$inferSelect;
export type NewBackfillCursor = typeof backfillCursor.$inferInsert;
