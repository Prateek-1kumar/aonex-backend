-- Catalog enrichment Phase 0 — dynamic-attribute spine + persisted scores.
--
-- 1) attribute_definitions: enrichment registry metadata so the typed attribute
--    dictionary can DRIVE enrichment and GROW itself (origin/status mark governed
--    LLM-discovered attributes; enrichment_group + applies_universally classify them).
-- 2) archetype_attribute_specs: DB-backed archetype -> attribute schemas (was code-only,
--    smartphone-only) so a human-accepted discovered attribute extends the schema at runtime.
-- 3) catalog_products: persisted, server-authoritative quality scores (0..100).

ALTER TABLE attribute_definitions
  ADD COLUMN IF NOT EXISTS label                    text,
  ADD COLUMN IF NOT EXISTS description              text,
  ADD COLUMN IF NOT EXISTS enrichment_group         varchar(32),
  ADD COLUMN IF NOT EXISTS applies_universally      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS origin                   varchar(20) NOT NULL DEFAULT 'seed',
  ADD COLUMN IF NOT EXISTS status                   varchar(20) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS proposed_from_product_id uuid;

CREATE TABLE IF NOT EXISTS archetype_attribute_specs (
  archetype_id  text NOT NULL,
  canonical_key text NOT NULL,
  tier          text NOT NULL,
  weight        numeric(4,3) NOT NULL DEFAULT 0.500,
  origin        text NOT NULL DEFAULT 'seed',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (archetype_id, canonical_key),
  CONSTRAINT archetype_attribute_specs_tier_chk CHECK (tier IN ('required','recommended','optional'))
);
CREATE INDEX IF NOT EXISTS idx_archetype_attr_specs_archetype ON archetype_attribute_specs (archetype_id);

ALTER TABLE catalog_products
  ADD COLUMN IF NOT EXISTS completeness_score    numeric(5,2),
  ADD COLUMN IF NOT EXISTS content_quality_score numeric(5,2),
  ADD COLUMN IF NOT EXISTS score_breakdown       jsonb;
