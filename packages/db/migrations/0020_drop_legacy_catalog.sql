-- Catalog redesign Phase 9, Task 9.1 — drop legacy catalog tables.
--
-- After cutover (Phase 8) renamed these tables to `_legacy_*` and the
-- 30-day post-cutover monitor passed clean (per
-- docs/runbooks/catalog-redesign-30day-monitor.md), drop the legacy
-- tables. Point of no return — no rollback to legacy after this applies.
--
-- DROP order is FK-reverse: dependent tables first, then their parents.
--   - proposed_diff_fields references proposed_diffs
--   - product_variant_versions references product_variants AND product_versions
--   - product_variants and product_identities reference products
--   - product_versions references products and proposed_diffs
--
-- See spec §23 (migration plan) and plan §9.1.

DROP TABLE _legacy_proposed_diff_fields;
DROP TABLE _legacy_proposed_diffs;
DROP TABLE _legacy_product_variant_versions;
DROP TABLE _legacy_product_variants;
DROP TABLE _legacy_product_identities;
DROP TABLE _legacy_product_versions;
DROP TABLE _legacy_products;
