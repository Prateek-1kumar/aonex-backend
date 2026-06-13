// catalog_events: partitioned outbox (workers claim via FOR UPDATE SKIP LOCKED;
// no FK on product_id/tenant_id) + catalog_events_dlq dead-letter queue (does not
// delete the source row). Partitioning on occurred_at forbids a UNIQUE on
// idempotency_key, so idempotency is enforced relay-side, not by a DB constraint.

import { pgTable, bigint, uuid, jsonb, text, timestamp, integer, index, primaryKey } from "drizzle-orm/pg-core";

export const catalogEvents = pgTable(
  "catalog_events",
  {
    eventId:         bigint("event_id", { mode: "number" }).generatedByDefaultAsIdentity(),
    eventType:       text("event_type").notNull(),
    productId:       uuid("product_id").notNull(),
    tenantId:        uuid("tenant_id").notNull(),
    payload:         jsonb("payload").notNull(),
    triggeredBy:     text("triggered_by"),
    occurredAt:      timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt:     timestamp("published_at", { withTimezone: true }),
    publishAttempts: integer("publish_attempts").notNull().default(0),
    idempotencyKey:  text("idempotency_key"),
    correlationId:   text("correlation_id"),
    traceId:         text("trace_id"),
    eventVersion:    integer("event_version").notNull().default(1),
    nextRetryAt:     timestamp("next_retry_at", { withTimezone: true })
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.occurredAt] }),
    unpublishedIdx: index("idx_catalog_events_unpublished").on(t.occurredAt),
    tenantIdx:      index("idx_catalog_events_tenant").on(t.tenantId, t.occurredAt),
    idempotencyIdx: index("idx_catalog_events_idempotency").on(t.idempotencyKey),
    retryIdx:       index("idx_catalog_events_next_retry").on(t.nextRetryAt)
  })
);

export const catalogEventsDlq = pgTable("catalog_events_dlq", {
  eventId:         bigint("event_id", { mode: "number" }).primaryKey(),
  originalPayload: jsonb("original_payload").notNull(),
  failureReason:   text("failure_reason").notNull(),
  failedAt:        timestamp("failed_at", { withTimezone: true }).notNull().defaultNow(),
  attempts:        integer("attempts").notNull()
});

export type CatalogEvent = typeof catalogEvents.$inferSelect;
export type NewCatalogEvent = typeof catalogEvents.$inferInsert;
export type CatalogEventDlq = typeof catalogEventsDlq.$inferSelect;
export type NewCatalogEventDlq = typeof catalogEventsDlq.$inferInsert;
