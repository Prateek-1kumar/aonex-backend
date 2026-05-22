-- Catalog redesign Phase 7, Task 7.1 — backfill_cursor.
--
-- Tracks resumable backfill progress per tenant. One row per tenant;
-- updated at the end of each processed batch. When completed_at is NOT NULL
-- the backfill is finished and re-running is a no-op unless --from-scratch
-- is passed (which clears or ignores the cursor).
--
-- last_product_version_id_processed: the highest product_version.id
-- processed so far (UUID natural order via pv.id > last_id). NULL means
-- the backfill has not started for this tenant.
--
-- total_processed / total_skipped / total_failed: counters accumulated
-- across all batch runs. They survive restarts (cursor row is updated, not
-- replaced) so the final summary reflects the full run.

CREATE TABLE backfill_cursor (
  tenant_id                          UUID PRIMARY KEY,
  last_product_version_id_processed  UUID,
  started_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at                       TIMESTAMPTZ,
  total_processed                    INTEGER NOT NULL DEFAULT 0,
  total_skipped                      INTEGER NOT NULL DEFAULT 0,
  total_failed                       INTEGER NOT NULL DEFAULT 0
);

-- Partial index for monitoring active (non-completed) backfill runs.
CREATE INDEX idx_backfill_cursor_active
  ON backfill_cursor (started_at)
  WHERE completed_at IS NULL;
