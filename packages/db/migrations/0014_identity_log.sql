-- Catalog redesign Phase 1, Task 1.8 — identity_log audit table.
-- Append-only log of changes to product identity fields (gtin, mpn, brand,
-- model_number, ...). Low-velocity, simple single-column PK — no partitioning.
-- See spec §5.

CREATE TABLE identity_log (
  log_id            BIGSERIAL PRIMARY KEY,
  product_id        UUID NOT NULL REFERENCES catalog_products(product_id),
  tenant_id         UUID NOT NULL,
  identity_field    TEXT NOT NULL,    -- 'gtin' | 'mpn' | 'brand' | 'model_number' | ...
  old_value         TEXT,
  new_value         TEXT,
  source            TEXT NOT NULL,
  source_record_id  TEXT,
  observed_at       TIMESTAMPTZ NOT NULL,
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  rationale         TEXT
);
