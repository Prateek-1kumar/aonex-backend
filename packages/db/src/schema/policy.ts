// HLD §14 / §20 — policy_versions.
// Phase 1 ships the table + seeds the default v1 row so audit
// rows can reference a `policy_version` from day one. The Policy
// Engine itself is Phase 2.

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
    /** ≥0.90 → auto_approved per HLD §14.1 */
    autoApproveThreshold: numeric("auto_approve_threshold", { precision: 4, scale: 4 })
      .notNull()
      .default("0.9000"),
    /** 0.55–0.89 → review_task per HLD §14.1 */
    anomalyThreshold: numeric("anomaly_threshold", { precision: 4, scale: 4 })
      .notNull()
      .default("0.5500"),
    /** <0.55 → rejected per HLD §14.1 */
    rejectThreshold: numeric("reject_threshold", { precision: 4, scale: 4 })
      .notNull()
      .default("0.5500"),
    /** Weighted scoring formula coefficients — HLD §14.1 */
    scoringWeights: jsonb("scoring_weights").$type<Record<string, number>>().notNull(),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    versionUnique: uniqueIndex("uq_policy_version").on(t.version)
  })
);

export type PolicyVersion = typeof policyVersions.$inferSelect;
