-- Catalog redesign Phase 1, Task 1.4 — catalog_product_revisions.
-- Partitioned monthly on ingested_at; append-only via immutability trigger.
-- No FK on product_id by design: revisions outlive their product (audit + replay).

CREATE TABLE catalog_product_revisions (
  revision_id              BIGSERIAL,
  product_id               UUID NOT NULL,
  tenant_id                UUID NOT NULL,
  values_snapshot          JSONB NOT NULL,
  winning_snapshot         JSONB,
  diff                     JSONB,
  revision_reason          TEXT NOT NULL,
  source_kind              TEXT,
  source_record_id         TEXT,
  triggered_by_artifact_id UUID,
  raw_payload              JSONB,
  observed_at              TIMESTAMPTZ,
  ingested_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor                    TEXT,
  suppress_outbound        BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (revision_id, ingested_at)
) PARTITION BY RANGE (ingested_at);

-- Bootstrap three monthly partitions. pg_partman keeps the rolling window in prod;
-- packages/db/README.md documents the local-dev manual fallback.
CREATE TABLE catalog_product_revisions_2026_05 PARTITION OF catalog_product_revisions
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE catalog_product_revisions_2026_06 PARTITION OF catalog_product_revisions
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE catalog_product_revisions_2026_07 PARTITION OF catalog_product_revisions
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE INDEX idx_revisions_product
  ON catalog_product_revisions (product_id, ingested_at DESC);
CREATE INDEX idx_revisions_source
  ON catalog_product_revisions (source_kind, source_record_id);

CREATE OR REPLACE FUNCTION block_revision_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'catalog_product_revisions is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_revisions_immutable
  BEFORE UPDATE OR DELETE ON catalog_product_revisions
  FOR EACH ROW EXECUTE FUNCTION block_revision_modification();
