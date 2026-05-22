-- Catalog redesign Phase 1, Task 1.6 — catalog_inventory_observations + catalog_inventory_current.
-- Observations: append-only, partitioned monthly on observed_at. INSERTs only.
-- Current: regular table maintained by the debounced async reconciler service
-- (NOT a DB trigger; see spec §9.1).

CREATE TABLE catalog_inventory_observations (
  observation_id          BIGSERIAL,
  product_id              UUID NOT NULL,
  tenant_id               UUID NOT NULL,
  channel_id              UUID NOT NULL REFERENCES channels(channel_id),
  location_id             UUID REFERENCES inventory_locations(location_id),
  qty                     INTEGER NOT NULL CHECK (qty >= 0),
  click_collect_eligible  BOOLEAN,
  purchase_limit          INTEGER,
  backorder_allowed       BOOLEAN,
  source                  TEXT NOT NULL,
  source_record_id        TEXT,
  observed_at             TIMESTAMPTZ NOT NULL,
  ingested_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  artifact_id             UUID,
  PRIMARY KEY (observation_id, observed_at)
) PARTITION BY RANGE (observed_at);

-- Initial 3 monthly partitions (matches catalog_pricing_observations bootstrap;
-- pg_partman maintains the rolling window in prod).
CREATE TABLE catalog_inventory_observations_2026_05 PARTITION OF catalog_inventory_observations
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE catalog_inventory_observations_2026_06 PARTITION OF catalog_inventory_observations
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE catalog_inventory_observations_2026_07 PARTITION OF catalog_inventory_observations
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE INDEX ON catalog_inventory_observations
  (product_id, channel_id, location_id, observed_at DESC);

-- Current table (regular table, app-maintained — not a materialized view, not a trigger).
-- Spec §9.1 declares PRIMARY KEY (product_id, channel_id, COALESCE(location_id, sentinel)).
-- Postgres does not allow expressions in a PK, so we materialise the coalesce result
-- as a STORED generated column and PK on plain columns. This preserves the spec's intent
-- ("NULL location_id collapses to the sentinel for uniqueness purposes") while keeping
-- location_id itself nullable (Option A in the task brief).
CREATE TABLE catalog_inventory_current (
  product_id           UUID NOT NULL,
  channel_id           UUID NOT NULL,
  location_id          UUID,
  location_id_coalesced UUID GENERATED ALWAYS AS
    (COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  qty                  INTEGER NOT NULL,
  source               TEXT NOT NULL,
  observed_at          TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (product_id, channel_id, location_id_coalesced)
);
CREATE INDEX ON catalog_inventory_current (channel_id, qty);
