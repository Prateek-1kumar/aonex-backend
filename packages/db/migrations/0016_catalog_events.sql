-- Catalog redesign Phase 1, Task 1.10 — catalog_events + catalog_events_dlq.
--
-- catalog_events: partitioned outbox table. Workers claim unpublished rows with
--   `FOR UPDATE SKIP LOCKED` for concurrent dispatch. No FK on product_id or
--   tenant_id by design — events outlive product deletion (audit + replay).
--   Partitioned monthly on occurred_at. pg_partman maintains the rolling window
--   in production; we bootstrap three months here.
--
-- catalog_events_dlq: dead-letter queue for events that failed N publish
--   attempts. Plain (non-partitioned) table; low volume. The original event row
--   is left in catalog_events — DLQ does not delete the source.
--
-- See spec §19; plan Task 1.10.

CREATE TABLE catalog_events (
  event_id          BIGSERIAL,
  event_type        TEXT NOT NULL,
  product_id        UUID NOT NULL,
  tenant_id         UUID NOT NULL,
  payload           JSONB NOT NULL,
  triggered_by      TEXT,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at      TIMESTAMPTZ,
  publish_attempts  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Bootstrap three monthly partitions. pg_partman keeps the rolling window in
-- production; packages/db/README.md documents the local-dev manual fallback.
CREATE TABLE catalog_events_2026_05 PARTITION OF catalog_events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE catalog_events_2026_06 PARTITION OF catalog_events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE catalog_events_2026_07 PARTITION OF catalog_events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- Partial index: backs the outbox worker's claim query
--   SELECT event_id FROM catalog_events
--   WHERE published_at IS NULL
--   ORDER BY occurred_at
--   FOR UPDATE SKIP LOCKED
--   LIMIT N
CREATE INDEX idx_catalog_events_unpublished
  ON catalog_events (occurred_at) WHERE published_at IS NULL;

CREATE INDEX idx_catalog_events_tenant
  ON catalog_events (tenant_id, occurred_at DESC);

CREATE TABLE catalog_events_dlq (
  event_id          BIGINT PRIMARY KEY,
  original_payload  JSONB NOT NULL,
  failure_reason    TEXT NOT NULL,
  failed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts          INT NOT NULL
);
