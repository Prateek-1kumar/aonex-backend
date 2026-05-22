-- Catalog redesign Phase 1, Task 1.5 — catalog_pricing_observations + catalog_pricing_current.
-- Observations: append-only, partitioned monthly on observed_at. INSERTs only.
-- Current: regular table maintained by the reconciler service (NOT a DB trigger;
-- see spec §8.1).

CREATE TABLE catalog_pricing_observations (
  observation_id   BIGSERIAL,
  product_id       UUID NOT NULL,
  tenant_id        UUID NOT NULL,
  channel_id       UUID NOT NULL REFERENCES channels(channel_id),
  locale           TEXT NOT NULL DEFAULT '_unscoped',
  source           TEXT NOT NULL,
  source_record_id TEXT,
  currency         TEXT NOT NULL,
  tiers            JSONB NOT NULL,
  price_per_unit   JSONB,
  observed_at      TIMESTAMPTZ NOT NULL,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  artifact_id      UUID,
  extras           JSONB,
  merged_from_product_id UUID,
  PRIMARY KEY (observation_id, observed_at)
) PARTITION BY RANGE (observed_at);

-- Initial 3 monthly partitions (same approach as revisions table)
CREATE TABLE catalog_pricing_observations_2026_05 PARTITION OF catalog_pricing_observations
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE catalog_pricing_observations_2026_06 PARTITION OF catalog_pricing_observations
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE catalog_pricing_observations_2026_07 PARTITION OF catalog_pricing_observations
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE INDEX ON catalog_pricing_observations (product_id, channel_id, observed_at DESC);
CREATE INDEX ON catalog_pricing_observations (tenant_id, observed_at DESC);

-- Current table (regular table, app-maintained — not a materialized view, not a trigger)
CREATE TABLE catalog_pricing_current (
  product_id     UUID NOT NULL,
  channel_id     UUID NOT NULL,
  locale         TEXT NOT NULL DEFAULT '_unscoped',
  source         TEXT NOT NULL,
  currency       TEXT NOT NULL,
  tiers          JSONB NOT NULL,
  price_per_unit JSONB,
  primary_amount NUMERIC,
  observed_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (product_id, channel_id, locale)
);
CREATE INDEX ON catalog_pricing_current (channel_id, primary_amount);
CREATE INDEX ON catalog_pricing_current (channel_id, currency, primary_amount);
