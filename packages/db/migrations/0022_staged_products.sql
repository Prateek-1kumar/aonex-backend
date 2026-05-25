-- Anomaly Lab — staging gate, Task 1. Hard-block staging area.
-- Ingests that fail the catalog readiness gate land here instead of
-- catalog_products. Promoted/rejected by a human via catalog-service.
-- See docs/superpowers/specs/2026-05-25-anomaly-lab-staging-gate-design.md §6.

CREATE TABLE staged_products (
  staged_product_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  merchant_id        UUID NOT NULL,
  proposed_identity  JSONB NOT NULL DEFAULT '{}'::jsonb,
  observations       JSONB NOT NULL,
  denorm_title       TEXT,
  denorm_brand       TEXT,
  denorm_price       NUMERIC,
  denorm_currency    TEXT,
  source_kind        TEXT NOT NULL,
  source_artifact_id UUID,
  channel_code       TEXT,
  gate_verdict       JSONB NOT NULL,
  match_candidates   JSONB NOT NULL DEFAULT '[]'::jsonb,
  human_fills        JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'pending',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by        UUID,
  resolved_at        TIMESTAMPTZ,
  CONSTRAINT staged_products_status_chk
    CHECK (status IN ('pending', 'promoted', 'rejected'))
);

CREATE INDEX idx_staged_products_tenant_status_created
  ON staged_products (tenant_id, status, created_at);

CREATE INDEX idx_staged_products_gate_verdict_gin
  ON staged_products USING GIN (gate_verdict);
