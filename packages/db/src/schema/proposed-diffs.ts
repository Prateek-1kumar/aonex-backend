// HLD §8 / §20 — proposed_diffs, proposed_diff_fields.
// "Only approved or auto_approved proposed_diffs create product_versions" (HLD §2.4).
// Idempotency: UNIQUE on (source_fact_set_id, diff_type) per spec §4 rule 10.

import {
  pgTable,
  uuid,
  varchar,
  numeric,
  boolean,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  index
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants.js";
import { merchants } from "./merchants.js";
import { extractedFactSets } from "./extraction.js";
import { policyVersions } from "./policy.js";
import { proposedDiffStatusEnum, actorTypeEnum } from "./enums.js";

/**
 * HLD §8 / §20 — proposed change to the canonical catalog.
 * Every product_version must trace back to an approved diff (NOT NULL FK).
 * UNIQUE on (source_fact_set_id, diff_type) makes idempotent re-runs safe.
 */
export const proposedDiffs = pgTable(
  "proposed_diffs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "restrict" }),
    sourceFactSetId: uuid("source_fact_set_id")
      .notNull()
      .references(() => extractedFactSets.id, { onDelete: "restrict" }),
    /** Null until dedup identifies an existing product to merge/update */
    productId: uuid("product_id"),
    /** "create" | "update" | "merge" */
    diffType: varchar("diff_type", { length: 20 }).notNull(),
    status: proposedDiffStatusEnum("status").notNull().default("pending"),
    policyVersionId: uuid("policy_version_id")
      .notNull()
      .references(() => policyVersions.id, { onDelete: "restrict" }),
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 4 }).notNull(),
    actorType: actorTypeEnum("actor_type").notNull().default("system"),
    actorId: uuid("actor_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    /** Full proposed canonical payload snapshot */
    diffPayload: jsonb("diff_payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    // Idempotency key per spec §4 rule 10
    idempotency: uniqueIndex("uq_proposed_diffs_idempotency").on(t.sourceFactSetId, t.diffType),
    statusIdx: index("idx_proposed_diffs_status").on(t.status, t.tenantId),
    productIdx: index("idx_proposed_diffs_product").on(t.productId)
  })
);

/**
 * HLD §8 / §20 — per-field breakdown of a proposed diff.
 * Enables reviewers to approve/reject individual fields.
 */
export const proposedDiffFields = pgTable(
  "proposed_diff_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    diffId: uuid("diff_id")
      .notNull()
      .references(() => proposedDiffs.id, { onDelete: "cascade" }),
    fieldName: varchar("field_name", { length: 200 }).notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    isAutoApproved: boolean("is_auto_approved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    diffIdx: index("idx_proposed_diff_fields_diff").on(t.diffId)
  })
);

export type ProposedDiff = typeof proposedDiffs.$inferSelect;
export type NewProposedDiff = typeof proposedDiffs.$inferInsert;
export type ProposedDiffField = typeof proposedDiffFields.$inferSelect;
export type NewProposedDiffField = typeof proposedDiffFields.$inferInsert;
