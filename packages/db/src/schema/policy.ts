// policy_versions: scoring thresholds + weights for the Policy Engine.
// A default v1 row is seeded so audit rows can reference a policy_version.

import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  numeric,
  jsonb,
  boolean,
  uniqueIndex
} from "drizzle-orm/pg-core";

export const policyVersions = pgTable(
  "policy_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human-readable version, e.g. 'v1', 'v1.1'. */
    version: varchar("version", { length: 32 }).notNull(),
    /** Score ≥ this → auto_approved. */
    autoApproveThreshold: numeric("auto_approve_threshold", { precision: 4, scale: 4 })
      .notNull()
      .default("0.9000"),
    /** Score in [anomaly, auto_approve) → review_task. */
    anomalyThreshold: numeric("anomaly_threshold", { precision: 4, scale: 4 })
      .notNull()
      .default("0.5500"),
    /** Score < this → rejected. */
    rejectThreshold: numeric("reject_threshold", { precision: 4, scale: 4 })
      .notNull()
      .default("0.5500"),
    /** Weighted scoring formula coefficients. */
    scoringWeights: jsonb("scoring_weights").$type<Record<string, number>>().notNull(),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    versionUnique: uniqueIndex("uq_policy_version").on(t.version)
  })
);

export type PolicyVersion = typeof policyVersions.$inferSelect;
