-- Catalog redesign Phase 3, Task 3.8 — add merged_from_product_id to
-- catalog_inventory_observations.
--
-- Spec §18.1 mandates that BOTH pricing and inventory side-table rows carry
-- merged_from_product_id so a future unmerge can re-attach them to the
-- restored loser. The pricing column was added in migration 0011 but the
-- equivalent on inventory observations was omitted from migration 0012.
-- This migration closes that gap so the merge/unmerge service can persist
-- the loser pointer symmetrically across both side tables.
--
-- Column is nullable (only set during merges) and carries no FK on
-- catalog_products by deliberate choice — lineage must outlive any future
-- hard-delete of the loser row (the row itself is tombstoned, never deleted,
-- but we keep this column FK-free to mirror the pricing-table treatment).

ALTER TABLE catalog_inventory_observations
  ADD COLUMN IF NOT EXISTS merged_from_product_id UUID;
