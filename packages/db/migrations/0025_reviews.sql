-- Phase 4 Task 8: normalized reviews table (spec D-rev).
-- Replaces the scalar-aggregate-per-channel approach with per-review records,
-- deduped by (product_id, dedupe_key) so cross-source re-imports don't double-count.

CREATE TABLE IF NOT EXISTS catalog_reviews (
  review_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES catalog_products(product_id) ON DELETE CASCADE,
  source      text NOT NULL,
  author      text,
  rating      numeric(3,2) NOT NULL,
  body        text,
  reviewed_at timestamptz,
  dedupe_key  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_catalog_reviews_product_id ON catalog_reviews (product_id);
