-- Phase 2: identity spine — multi-identifier set, escape hatch, pipeline version stamp.
-- Spec: docs/superpowers/specs/2026-05-27-ingestion-platform-redesign-design.md §13.1, C1, C5.

ALTER TABLE catalog_products
  ADD COLUMN IF NOT EXISTS identifiers       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS identifier_exists boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pipeline_version  integer NOT NULL DEFAULT 1;

-- GIN index so "match on any identifier value" is an indexed containment lookup, not a scan.
CREATE INDEX IF NOT EXISTS idx_catalog_products_identifiers
  ON catalog_products USING gin (identifiers jsonb_path_ops);

-- Concurrency guard (spec review-hardening, plan §15): two simultaneous creates with the
-- same STRONG identifier cannot both win. The loser's insert conflicts → it re-reads and
-- attaches to the row the winner created. Strong identifiers are projected into a
-- dedicated table so a UNIQUE constraint applies.
CREATE TABLE IF NOT EXISTS product_strong_identifiers (
  tenant_id        uuid NOT NULL,
  identifier_type  text NOT NULL,
  identifier_value text NOT NULL,
  product_id       uuid NOT NULL REFERENCES catalog_products(product_id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, identifier_type, identifier_value)
);
