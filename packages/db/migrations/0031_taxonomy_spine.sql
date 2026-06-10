-- Taxonomy spine (P0) — canonical product-taxonomy tree + aliases + external
-- crosswalk + per-leaf attribute schema. See docs/taxonomy-spine-p0-spec.md.
--
-- Additive + idempotent (IF NOT EXISTS). Rollback = drop the four new tables,
-- the catalog_products.category_node_id column, and the attribute_definitions
-- .provenance column (all additive; nullable column so existing rows are safe).

-- 1) The tree. Slug-path ids; system- and gender-agnostic.
CREATE TABLE IF NOT EXISTS taxonomy_nodes (
  node_id      text PRIMARY KEY,
  parent_id    text REFERENCES taxonomy_nodes(node_id),
  level        integer NOT NULL,
  display_name text NOT NULL,
  display_path text NOT NULL,
  is_leaf      boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'active',
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT taxonomy_nodes_status_chk CHECK (status IN ('active','draft','deprecated'))
);
CREATE INDEX IF NOT EXISTS idx_taxonomy_nodes_parent ON taxonomy_nodes (parent_id);
CREATE INDEX IF NOT EXISTS idx_taxonomy_nodes_status ON taxonomy_nodes (status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_taxonomy_nodes_display_path ON taxonomy_nodes (display_path);

-- 2) Messy label -> node (normalization + learning loop).
CREATE TABLE IF NOT EXISTS taxonomy_aliases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_label text NOT NULL,
  source_context   text NOT NULL DEFAULT '*',
  node_id          text NOT NULL REFERENCES taxonomy_nodes(node_id) ON DELETE CASCADE,
  origin           text NOT NULL DEFAULT 'seed',
  confidence       numeric(4,3) NOT NULL DEFAULT 1.000,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT taxonomy_aliases_origin_chk CHECK (origin IN ('seed','human','learned'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_taxonomy_aliases_label_ctx
  ON taxonomy_aliases (normalized_label, source_context);
CREATE INDEX IF NOT EXISTS idx_taxonomy_aliases_node ON taxonomy_aliases (node_id);

-- 3) node <-> external taxonomy crosswalk (generic over every system).
CREATE TABLE IF NOT EXISTS taxonomy_node_mappings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id       text NOT NULL REFERENCES taxonomy_nodes(node_id) ON DELETE CASCADE,
  system        text NOT NULL,
  external_id   text,
  external_path text,
  role          text NOT NULL,
  is_primary    boolean NOT NULL DEFAULT false,
  confidence    numeric(4,3) NOT NULL DEFAULT 1.000,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT taxonomy_node_mappings_role_chk CHECK (role IN ('export','import','schema_source','reference'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_taxonomy_node_mappings
  ON taxonomy_node_mappings (node_id, system, role);
CREATE INDEX IF NOT EXISTS idx_taxonomy_node_mappings_ext
  ON taxonomy_node_mappings (system, external_id);

-- 4) Per-leaf attribute schema (normalized: node -> attribute + tier).
--    canonical_key resolves to attribute_definitions.canonical_key; not a DB FK
--    because that column has a unique INDEX (not a unique CONSTRAINT). The seed
--    loader + validator enforce resolution.
CREATE TABLE IF NOT EXISTS node_attributes (
  node_id         text NOT NULL REFERENCES taxonomy_nodes(node_id) ON DELETE CASCADE,
  canonical_key   text NOT NULL,
  tier            text NOT NULL,
  is_variant_axis boolean NOT NULL DEFAULT false,
  sort_order      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, canonical_key),
  CONSTRAINT node_attributes_tier_chk CHECK (tier IN ('required','recommended','optional'))
);
CREATE INDEX IF NOT EXISTS idx_node_attributes_key ON node_attributes (canonical_key);

-- 5) Extend the existing canonical attribute catalogue with merge provenance
--    (which external source(s) an attribute/value-set was sourced/merged from).
ALTER TABLE attribute_definitions
  ADD COLUMN IF NOT EXISTS provenance jsonb;

-- 6) Link products to the canonical tree. Nullable in P0 (populated by the P1
--    classifier); FK to the tree. Free-text family/category_path stay as a
--    read-only fallback during transition.
ALTER TABLE catalog_products
  ADD COLUMN IF NOT EXISTS category_node_id text REFERENCES taxonomy_nodes(node_id);
CREATE INDEX IF NOT EXISTS idx_catalog_products_category_node
  ON catalog_products (category_node_id);
