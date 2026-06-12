-- Catalog redesign Phase 9, Task 9.1 — drop legacy catalog tables.
--
-- After cutover (Phase 8) renamed these tables to `_legacy_*` and the
-- 30-day post-cutover monitor passed clean (per
-- docs/runbooks/catalog-redesign-30day-monitor.md), drop the legacy
-- tables. Point of no return — no rollback to legacy after this applies.
--
-- IMPORTANT: this migration drops ONLY the `_legacy_*`-prefixed tables — the
-- ones the manual Phase 8 cutover renamed out of the way. It must NOT touch the
-- bare-named tables (products, proposed_diffs, proposed_diff_fields, …): the
-- catalog-redesign code cutover was never completed, so those 0000 tables are
-- STILL live — the ingestion spine writes proposed_diffs, and apps/api review
-- handlers read proposed_diffs / proposed_diff_fields / product_identities.
-- Dropping the bare names breaks ingestion (spine throws "relation
-- proposed_diffs does not exist") and the review flow.
--
-- IF EXISTS makes this idempotent and safe on a fresh database (e.g. local dev
-- after `docker compose down -v`), where the `_legacy_*` tables never existed —
-- the manual rename only ever happened in production. See spec §23 / plan §9.1.

DROP TABLE IF EXISTS _legacy_proposed_diff_fields;
DROP TABLE IF EXISTS _legacy_proposed_diffs;
DROP TABLE IF EXISTS _legacy_product_variant_versions;
DROP TABLE IF EXISTS _legacy_product_variants;
DROP TABLE IF EXISTS _legacy_product_identities;
DROP TABLE IF EXISTS _legacy_product_versions;
DROP TABLE IF EXISTS _legacy_products;
