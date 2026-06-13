// Catalog redesign Phase 1, Task 1.10 — catalog_events outbox + DLQ.
//
// catalog_events is a partitioned outbox table. Workers claim unpublished rows
// with `FOR UPDATE SKIP LOCKED` for concurrent dispatch. No FK on product_id or
// tenant_id by design — events outlive product deletion (audit + replay).
// Partitioned monthly on occurred_at.
//
// catalog_events_dlq is the dead-letter queue for events that failed N publish
// attempts. Plain (non-partitioned) table; low volume. The original event row
// is left in catalog_events — DLQ does not delete the source.
//
// Drizzle schema is used for INSERT/SELECT typing only; the migration is the
// ground truth — see migrations/0016_catalog_events.sql.

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
    // Production-outbox observability fields (migration 0030, review §11).
    //   idempotencyKey — relay-side dedupe; the publisher skips a row whose key
    //     it has already delivered. Nullable for back-compat with pre-0030 rows.
    //     NOTE: catalog_events is partitioned on occurred_at, and Postgres forbids
    //     a UNIQUE constraint that doesn't include every partition-key column, so
    //     uniqueness is enforced relay-side (claim → check → mark), not by a DB
    //     constraint. The index below is a plain lookup index.
    idempotencyKey:  text("idempotency_key"),
    //   correlationId / traceId — propagate the originating request/trace so an
    //     event can be tied back to the ingestion that produced it across services.
    correlationId:   text("correlation_id"),
    traceId:         text("trace_id"),
    //   eventVersion — payload schema version so consumers can evolve safely.
    eventVersion:    integer("event_version").notNull().default(1),
    //   nextRetryAt — backoff gate. The relay claims rows where published_at IS
    //     NULL AND (next_retry_at IS NULL OR next_retry_at <= now()); on a failed
    //     publish it sets next_retry_at = now() + backoff(publish_attempts).
    nextRetryAt:     timestamp("next_retry_at", { withTimezone: true })
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.occurredAt] }),
    // Partial index over unpublished rows — backs the outbox worker claim query.
    // Drizzle does not model the WHERE predicate; the migration declares it.
    unpublishedIdx: index("idx_catalog_events_unpublished").on(t.occurredAt),
    tenantIdx:      index("idx_catalog_events_tenant").on(t.tenantId, t.occurredAt),
    // Lookup index for relay-side idempotency checks (partial: only set rows).
    idempotencyIdx: index("idx_catalog_events_idempotency").on(t.idempotencyKey),
    // Backs the backoff-aware claim: unpublished rows due for (re)delivery.
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
