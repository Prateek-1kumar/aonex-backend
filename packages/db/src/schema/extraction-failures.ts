import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { reviewTasks } from "./review.js";
import { extractionFailureReasonEnum } from "./enums.js";

export const extractionFailures = pgTable(
  "extraction_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domainPattern: varchar("domain_pattern", { length: 200 }).notNull(),
    rawKey: varchar("raw_key", { length: 200 }),
    sourcePointer: text("source_pointer"),
    reason: extractionFailureReasonEnum("reason").notNull(),
    reviewerNote: text("reviewer_note"),
    reviewTaskId: uuid("review_task_id").references(() => reviewTasks.id),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    domainReasonIdx: index("idx_extraction_failures_domain_reason").on(
      t.domainPattern,
      t.reason
    ),
  })
);

export type ExtractionFailure = typeof extractionFailures.$inferSelect;
export type NewExtractionFailure = typeof extractionFailures.$inferInsert;
