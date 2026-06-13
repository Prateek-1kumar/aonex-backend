-- Fix the catalog_products.gen_title generated column.
--
-- 0009 generated gen_title from `winning_values #>> '{title,_primary,value}'`,
-- but real reconciled data stores titles scoped as bare strings at
-- `winning_values -> 'title' -> <scope> -> '_unscoped'` (e.g.
-- `{title,_unscoped,_unscoped}`), so gen_title was NULL for EVERY row — which
-- silently broke the ?q= search (gen_title ILIKE) and every proposal-list
-- title. Replace the expression with a COALESCE chain over the real shape, the
-- legacy shape, and a generic scoped fallback for marketplace-only rows (e.g. a
-- product seen only on amazon-in with no `_unscoped` scope).
--
-- Dropping the column also drops idx_catalog_products_gen_title_trgm (it indexes
-- only this column), so it is recreated below. Mirrors 0009.

ALTER TABLE catalog_products
  DROP COLUMN IF EXISTS gen_title;

ALTER TABLE catalog_products
  ADD COLUMN gen_title TEXT
    GENERATED ALWAYS AS (
      COALESCE(
        -- canonical: unscoped title stored as a bare string (current real shape)
        winning_values #>> '{title,_unscoped,_unscoped}',
        -- unscoped title wrapped as { value: ... }
        winning_values #>> '{title,_unscoped,_unscoped,value}',
        -- legacy primary-scope shape (the original 0009 expression)
        winning_values #>> '{title,_primary,value}',
        -- generic fallback: first scoped title (marketplace-only rows, e.g. amazon-in)
        jsonb_path_query_first(winning_values, '$.title.*._unscoped') #>> '{}'
      )
    ) STORED;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_catalog_products_gen_title_trgm
  ON catalog_products USING GIN (gen_title gin_trgm_ops);
