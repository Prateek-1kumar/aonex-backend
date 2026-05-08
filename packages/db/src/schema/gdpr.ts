// LLD §15 — GDPR Article 17 (right to erasure) workflow.
// 30-day SLA per Article 12(3); auto-computed `sla_deadline`.
// HLD §22 implies this in "Security/Multi-tenancy"; LLD makes it concrete.

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { merchants } from "./merchants.js";
import { deletionRequestStatusEnum } from "./enums.js";

export const deletionRequests = pgTable(
  "deletion_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    requestedBy: varchar("requested_by", { length: 320 }).notNull(),
    reason: text("reason"),
    status: deletionRequestStatusEnum("status").notNull().default("pending"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Generated column — requested_at + 30d (Article 12(3)). */
    slaDeadline: timestamp("sla_deadline", { withTimezone: true }).generatedAlwaysAs(
      sql`requested_at + INTERVAL '30 days'`
    ),
    rejectionReason: text("rejection_reason")
  },
  (t) => ({
    merchantIdx: index("idx_deletion_requests_merchant").on(t.merchantId),
    statusIdx: index("idx_deletion_requests_status").on(t.status)
  })
);

export type DeletionRequest = typeof deletionRequests.$inferSelect;
