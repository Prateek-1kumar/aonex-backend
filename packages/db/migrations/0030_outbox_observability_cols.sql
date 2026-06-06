-- Review §11 (production outbox) — add observability + idempotency + backoff
-- fields to the catalog_events outbox. The original table (migration 0016) had
-- the load-bearing parts (monthly partitioning, FOR UPDATE SKIP LOCKED claim,
-- publish_attempts, a DLQ table) but lacked the fields needed to operate it
-- safely at scale: dedupe, request/trace correlation, payload versioning, and a
-- backoff gate.
--
-- Partitioning caveat: catalog_events is partitioned on occurred_at, and
-- Postgres forbids a UNIQUE constraint that excludes a partition-key column.
-- So idempotency_key uniqueness is enforced relay-side (claim → check delivered
-- → mark published), not by a DB constraint. The index below is a plain partial
-- lookup index over set keys, not a uniqueness guarantee.

ALTER TABLE catalog_events
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS correlation_id  TEXT,
  ADD COLUMN IF NOT EXISTS trace_id        TEXT,
  ADD COLUMN IF NOT EXISTS event_version   INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS next_retry_at   TIMESTAMPTZ;

-- Relay-side idempotency lookups: only index rows that actually carry a key.
CREATE INDEX IF NOT EXISTS idx_catalog_events_idempotency
  ON catalog_events (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Backs the backoff-aware claim query:
--   SELECT ... FROM catalog_events
--   WHERE published_at IS NULL
--     AND (next_retry_at IS NULL OR next_retry_at <= now())
--   ORDER BY occurred_at FOR UPDATE SKIP LOCKED
CREATE INDEX IF NOT EXISTS idx_catalog_events_next_retry
  ON catalog_events (next_retry_at) WHERE published_at IS NULL;
