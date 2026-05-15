// HLD §15 / §20 — review_tasks.
// Written by the Policy Engine when score ∈ [0.55, 0.90).
// Anomaly Lab UI (Phase 4) reads these rows; we only write them here.

import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  index
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { merchants } from "./merchants.js";
import { proposedDiffs } from "./proposed-diffs.js";
import { policyVersions } from "./policy.js";
import { reviewTaskSeverityEnum, reviewTaskStatusEnum } from "./enums.js";

export const reviewTasks = pgTable(
  "review_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    proposedDiffId: uuid("proposed_diff_id")
      .notNull()
      .references(() => proposedDiffs.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id"),
    /**
     * "category_unmatched" | "low_confidence" | "dedupe_conflict" | "schema_violation"
     * Corresponds to the policy evidence fields.
     */
    taskType: varchar("task_type", { length: 50 }).notNull(),
    signalKind: varchar("signal_kind", { length: 50 }),
    signalPayload: jsonb("signal_payload").$type<Record<string, unknown>>(),
    clusterKey: varchar("cluster_key", { length: 64 }),
    fieldName: varchar("field_name", { length: 100 }),
    severity: reviewTaskSeverityEnum("severity").notNull(),
    status: reviewTaskStatusEnum("status").notNull().default("open"),
    assignedTo: uuid("assigned_to"),
    resolutionNotes: text("resolution_notes"),
    policyVersionId: uuid("policy_version_id").references(() => policyVersions.id, {
      onDelete: "restrict"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    tenantStatusIdx: index("idx_review_tasks_tenant_status").on(t.tenantId, t.status),
    diffIdx: index("idx_review_tasks_diff").on(t.proposedDiffId),
    clusterIdx: index("idx_review_tasks_cluster").on(t.tenantId, t.clusterKey, t.status)
  })
);

export type ReviewTask = typeof reviewTasks.$inferSelect;
export type NewReviewTask = typeof reviewTasks.$inferInsert;
