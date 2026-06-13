// source_priority: effective-dated rules deciding which source wins per attribute.
// Tenant-scoped (tenant_id set) or global (tenant_id NULL); active rules have
// effective_to IS NULL, tombstoned ones set it to now(). The partial lookup index
// (WHERE effective_to IS NULL) lives in the SQL migration, which is truth.

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
    tenantId:      uuid("tenant_id"),
    attributeCode: text("attribute_code"),
    sourceGlob:    text("source_glob").notNull(),
    channelScope:  text("channel_scope"),
    priority:      integer("priority").notNull(),
    predicate:     jsonb("predicate"),
    rulesVersion:  integer("rules_version").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveTo:   timestamp("effective_to", { withTimezone: true }),
    actor:         text("actor"),
    createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  }
);

export type SourcePriority = typeof sourcePriority.$inferSelect;
export type NewSourcePriority = typeof sourcePriority.$inferInsert;
