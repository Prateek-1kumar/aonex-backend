// audit_events: append-only (the app DB role has no UPDATE/DELETE).
// merchant_id is intentionally NOT a foreign key so audit rows survive
// merchant deletion (GDPR purge).

import { pgTable, uuid, varchar, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { actorTypeEnum } from "./enums.js";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Plain UUID — NO FK by design. */
    tenantId: uuid("tenant_id").notNull(),
    merchantId: uuid("merchant_id"),
    actorId: uuid("actor_id"),
    actorType: actorTypeEnum("actor_type").notNull(),
    /** Past-tense domain event — e.g. 'connection.created', 'sync.completed'. */
    eventType: varchar("event_type", { length: 100 }).notNull(),
    entityType: varchar("entity_type", { length: 50 }),
    entityId: varchar("entity_id", { length: 200 }),
    requestId: varchar("request_id", { length: 64 }),
    traceId: varchar("trace_id", { length: 64 }),
    payloadHash: varchar("payload_hash", { length: 64 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    merchantCreated: index("idx_audit_merchant_created").on(t.merchantId, t.createdAt),
    entityIdx: index("idx_audit_entity").on(t.entityType, t.entityId),
    eventTypeIdx: index("idx_audit_event_type").on(t.eventType)
  })
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
