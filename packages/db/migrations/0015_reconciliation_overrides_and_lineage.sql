-- Catalog redesign Phase 1, Task 1.9 — reconciliation_overrides + product_lineage.
--
-- reconciliation_overrides: per-product manual pins on a winning value.
--   Tenant scope is inherited via the catalog_products FK. Time-bounded pins
--   set frozen_until; permanent pins leave it NULL. ON DELETE CASCADE so a
--   product's pins go away with it.
--
-- product_lineage: append-only history of merge/split/unmerge operations.
--   No ON DELETE clause on the FKs (NO ACTION default) — lineage outlives
--   merges by design.
--
-- See spec §5.

CREATE TABLE reconciliation_overrides (
  override_id    BIGSERIAL PRIMARY KEY,
  product_id     UUID NOT NULL REFERENCES catalog_products(product_id) ON DELETE CASCADE,
  attribute_code TEXT NOT NULL,
  channel_code   TEXT NOT NULL,
  locale_code    TEXT NOT NULL DEFAULT '_unscoped',
  frozen_value   JSONB NOT NULL,
  frozen_until   TIMESTAMPTZ,
  actor          TEXT NOT NULL,
  rationale      TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product_lineage (
  lineage_id          BIGSERIAL PRIMARY KEY,
  product_id          UUID NOT NULL REFERENCES catalog_products(product_id),
  origin_product_id   UUID NOT NULL REFERENCES catalog_products(product_id),
  operation           TEXT NOT NULL,    -- 'merge' | 'split' | 'unmerge'
  split_filter        JSONB,            -- present for 'split'
  rationale           TEXT,
  actor               TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_product_lineage_product ON product_lineage (product_id);
CREATE INDEX idx_product_lineage_origin  ON product_lineage (origin_product_id);
