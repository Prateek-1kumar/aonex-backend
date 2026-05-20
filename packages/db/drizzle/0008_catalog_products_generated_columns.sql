-- Task 1.3: Add generated columns and GIN indexes to catalog_products.
-- Drizzle does not model GENERATED ALWAYS AS ... STORED columns, so this is a
-- hand-written raw SQL migration registered manually in the journal.

ALTER TABLE catalog_products
  ADD COLUMN gen_brand TEXT
    GENERATED ALWAYS AS (identity->>'brand') STORED,
  ADD COLUMN gen_gtin TEXT
    GENERATED ALWAYS AS (identity->>'gtin') STORED,
  ADD COLUMN gen_primary_currency TEXT
    GENERATED ALWAYS AS (winning_values #>> '{pricing,_primary,currency}') STORED,
  ADD COLUMN gen_primary_price NUMERIC
    GENERATED ALWAYS AS ((winning_values #>> '{pricing,_primary,tiers,0,amount}')::numeric) STORED,
  ADD COLUMN gen_inventory_total INT
    GENERATED ALWAYS AS ((winning_values #>> '{inventory,_primary,total}')::int) STORED,
  ADD COLUMN gen_title TEXT
    GENERATED ALWAYS AS (winning_values #>> '{title,_primary,value}') STORED;

CREATE INDEX idx_catalog_products_gen_brand
  ON catalog_products (gen_brand) WHERE gen_brand IS NOT NULL;
CREATE INDEX idx_catalog_products_gen_gtin
  ON catalog_products (gen_gtin) WHERE gen_gtin IS NOT NULL;
CREATE INDEX idx_catalog_products_gen_brand_price
  ON catalog_products (gen_brand, gen_primary_price);
CREATE INDEX idx_catalog_products_gen_inventory_total
  ON catalog_products (gen_inventory_total);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_catalog_products_gen_title_trgm
  ON catalog_products USING GIN (gen_title gin_trgm_ops);
CREATE INDEX idx_catalog_products_values_gin
  ON catalog_products USING GIN (values);
