-- Add category_node_id to staged_products.
--
-- The ingestion spine now resolves a canonical taxonomy node at the classify
-- stage (LLM auto-categorization) and persists it on both admit
-- (catalog_products.category_node_id, already exists) and stage. Staged products
-- previously had no category column, so they could never be auto-categorized and
-- always required a manual pick in the Lab. This column lets the Review Queue
-- modal show/confirm the auto-assigned node and lets post-approve enrichment run.

ALTER TABLE staged_products
  ADD COLUMN IF NOT EXISTS category_node_id text;
