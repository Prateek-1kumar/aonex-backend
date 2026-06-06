-- Review §2 (tenant isolation) — add tenant_id to the read-model `_current`
-- tables. The *_observations tables already carry tenant_id; the current tables
-- (catalog_pricing_current, catalog_inventory_current) did not, so any
-- per-tenant price/stock filter had to round-trip through catalog_products and
-- nothing enforced the tenant boundary on these rows.
--
-- The async-debounced reconciler is the ONLY writer of these tables and now
-- stamps tenant_id from the product row (catalog-service async-debounced.ts).
-- This migration backfills existing rows from catalog_products before enforcing
-- NOT NULL, so it is safe to apply with data present.
--
-- Indexes lead with tenant_id (review: "most indexes should start with
-- tenant_id"). The old channel-leading indexes from migrations 0011/0012 are
-- dropped — the tenant-leading composites cover the same channel/price/currency
-- and channel/qty access paths for tenant-scoped queries.

-- ---- catalog_pricing_current ----------------------------------------------
ALTER TABLE catalog_pricing_current
  ADD COLUMN IF NOT EXISTS tenant_id UUID;

UPDATE catalog_pricing_current c
SET tenant_id = p.tenant_id
FROM catalog_products p
WHERE c.product_id = p.product_id
  AND c.tenant_id IS NULL;

-- Any row we still couldn't assign a tenant to has no parent in
-- catalog_products — an unreferenceable read-model orphan (e.g. left behind
-- after a product hard-delete). The reconciler re-derives _current rows from
-- the observation side tables, so dropping these is lossless. Removing them
-- here lets SET NOT NULL succeed in any environment.
DELETE FROM catalog_pricing_current WHERE tenant_id IS NULL;

ALTER TABLE catalog_pricing_current
  ALTER COLUMN tenant_id SET NOT NULL;

-- Auto-named indexes from migration 0011 (CREATE INDEX ON ... (channel_id, ...)).
DROP INDEX IF EXISTS catalog_pricing_current_channel_id_primary_amount_idx;
DROP INDEX IF EXISTS catalog_pricing_current_channel_id_currency_primary_amount_idx;

CREATE INDEX IF NOT EXISTS idx_catalog_pricing_current_tenant_channel_price
  ON catalog_pricing_current (tenant_id, channel_id, primary_amount);
CREATE INDEX IF NOT EXISTS idx_catalog_pricing_current_tenant_channel_currency_price
  ON catalog_pricing_current (tenant_id, channel_id, currency, primary_amount);

-- ---- catalog_inventory_current --------------------------------------------
ALTER TABLE catalog_inventory_current
  ADD COLUMN IF NOT EXISTS tenant_id UUID;

UPDATE catalog_inventory_current c
SET tenant_id = p.tenant_id
FROM catalog_products p
WHERE c.product_id = p.product_id
  AND c.tenant_id IS NULL;

-- See the pricing-table note above: drop unreferenceable read-model orphans so
-- SET NOT NULL succeeds; they re-derive on the next inventory reconcile.
DELETE FROM catalog_inventory_current WHERE tenant_id IS NULL;

ALTER TABLE catalog_inventory_current
  ALTER COLUMN tenant_id SET NOT NULL;

-- Auto-named index from migration 0012 (CREATE INDEX ON ... (channel_id, qty)).
DROP INDEX IF EXISTS catalog_inventory_current_channel_id_qty_idx;

CREATE INDEX IF NOT EXISTS idx_catalog_inventory_current_tenant_channel_qty
  ON catalog_inventory_current (tenant_id, channel_id, qty);
