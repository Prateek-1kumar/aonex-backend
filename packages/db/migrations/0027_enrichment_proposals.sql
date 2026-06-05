-- Catalog enrichment Phase 1 — review-then-apply proposals.
-- One row per "Push to Enrich" run: the before->after field diff + discovered
-- candidate attributes + projected score delta. Nothing touches the catalog until
-- the proposal is applied (accepted fields -> observations, accepted candidates
-- -> registered attributes).

CREATE TABLE IF NOT EXISTS enrichment_proposals (
  proposal_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  merchant_id    uuid NOT NULL,
  product_id     uuid NOT NULL REFERENCES catalog_products(product_id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending',
  archetype      text,
  model          text,
  prompt_version text NOT NULL DEFAULT 'enrich-v1',
  fields         jsonb NOT NULL DEFAULT '[]'::jsonb,
  candidates     jsonb NOT NULL DEFAULT '[]'::jsonb,
  score_before   jsonb,
  score_after    jsonb,
  reasoning      text,
  cost_usd       numeric(10,5),
  job_id         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  resolved_by    uuid,
  resolved_at    timestamptz,
  CONSTRAINT enrichment_proposals_status_chk
    CHECK (status IN ('pending','generating','ready','applied','rejected','failed'))
);

CREATE INDEX IF NOT EXISTS idx_enrich_prop_tenant_status
  ON enrichment_proposals (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_enrich_prop_product
  ON enrichment_proposals (product_id);
