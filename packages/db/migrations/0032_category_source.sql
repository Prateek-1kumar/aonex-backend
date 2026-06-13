-- P1.5: category provenance for the sticky-category rule.
--
-- category_node_id is STRUCTURAL — it is not a reconciled winning_value, so a
-- connector re-sync never thrashes it (the reconciler only touches
-- winning_values). category_source records HOW the node was set so the
-- classifier never overwrites a human decision:
--   'auto'  = assigned by the classifier sweep (may be corrected by a higher-
--             confidence signal or a human)
--   'human' = confirmed in the Lab (ground truth; never auto-overwritten)
--   null    = not categorized yet
ALTER TABLE catalog_products
  ADD COLUMN IF NOT EXISTS category_source text;
