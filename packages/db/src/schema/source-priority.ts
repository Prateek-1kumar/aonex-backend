// Catalog redesign Phase 1, Task 1.7 — source_priority rules table.
//
// Effective-dated rules that decide which source wins for each attribute.
// Tenant-scoped (tenant_id set) or global (tenant_id NULL). Tombstoning is
// done by setting effective_to = now(); active rules have effective_to IS NULL.
//
// The lookup index is a PARTIAL index keyed by
// (tenant_id, attribute_code, source_glob, channel_scope) WHERE effective_to IS NULL.
// Drizzle does not model WHERE predicates on indexes, so the partial-index
// definition lives in migrations/0013_source_priority.sql (ground truth).

import {
  pgTable,
  uuid,
  bigint,
  text,
  integer,
  jsonb,
  timestamp
} from "drizzle-orm/pg-core";

export const sourcePriority = pgTable(
  "source_priority",
  {
    ruleId:        bigint("rule_id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    tenantId:      uuid("tenant_id"),               // nullable: NULL = global default
    attributeCode: text("attribute_code"),          // nullable: NULL = all attributes
    sourceGlob:    text("source_glob").notNull(),
    channelScope:  text("channel_scope"),
    priority:      integer("priority").notNull(),
    predicate:     jsonb("predicate"),              // JSONLogic, nullable (v2)
    rulesVersion:  integer("rules_version").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveTo:   timestamp("effective_to", { withTimezone: true }),
    actor:         text("actor"),
    createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  }
);

export type SourcePriority = typeof sourcePriority.$inferSelect;
export type NewSourcePriority = typeof sourcePriority.$inferInsert;
