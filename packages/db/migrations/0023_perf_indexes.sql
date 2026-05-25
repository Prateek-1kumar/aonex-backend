-- Phase 4 (production hardening) — performance indexes for hot list/scan queries.
--
-- Targets three confirmed-missing access paths (verified against pg_indexes):
--   1. Paginated catalog list — apps/api/src/services/new-catalog-list.ts filters
--      (tenant_id, merchant_id, status != 'merged_into') and orders by
--      (updated_at DESC, product_id DESC). The existing (tenant_id, status) index
--      can't serve the merchant filter + keyset ordering.
--   2. Watchdog continuous/hourly sweep — packages/catalog/watchdog scans
--      WHERE updated_at > now() - interval, tenant-agnostic. No updated_at index
--      existed → sequential scan every 5 minutes.
--   3. Recent-ingestions list — apps/api/src/handlers/ingestions.ts filters
--      (merchant_id, source_type) and orders by received_at DESC.
--
-- IF NOT EXISTS keeps this safe to re-run. NOTE for production: build these
-- CONCURRENTLY out-of-band on large tables to avoid a write lock — this file
-- uses plain CREATE INDEX (node-pg-migrate wraps migrations in a transaction,
-- which disallows CONCURRENTLY) and is intended for dev/staging apply.

CREATE INDEX IF NOT EXISTS idx_catalog_products_tenant_merchant_updated
  ON catalog_products (tenant_id, merchant_id, updated_at DESC, product_id DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_products_updated_at
  ON catalog_products (updated_at);

CREATE INDEX IF NOT EXISTS idx_source_artifacts_merchant_type_received
  ON source_artifacts (merchant_id, source_type, received_at DESC);
