-- ============================================================
-- Immutability triggers — HLD "Persist source_artifacts ...
-- before touching catalog tables" + LLD P0-3 fix.
--
-- Applied via Drizzle migration `sql.raw()` in 0001_triggers.sql.
-- The only legitimate path that mutates immutable rows is the
-- GDPR purge worker, which uses
--   SET LOCAL session_replication_role = 'replica'
-- to bypass triggers within a single transaction.
-- ============================================================

-- ----------------------------------------------------------------
-- source_artifacts: only `status`, `processing_errors`, and
-- `sync_job_run_id` are mutable. Everything else is frozen.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION block_source_artifact_mutation()
RETURNS trigger AS $$
BEGIN
    IF NEW.tenant_id           IS DISTINCT FROM OLD.tenant_id           OR
       NEW.merchant_id         IS DISTINCT FROM OLD.merchant_id         OR
       NEW.source_type         IS DISTINCT FROM OLD.source_type         OR
       NEW.source_marketplace  IS DISTINCT FROM OLD.source_marketplace  OR
       NEW.source_external_id  IS DISTINCT FROM OLD.source_external_id  OR
       NEW.parent_artifact_id  IS DISTINCT FROM OLD.parent_artifact_id  OR
       NEW.storage_uri         IS DISTINCT FROM OLD.storage_uri         OR
       NEW.raw_data            IS DISTINCT FROM OLD.raw_data            OR
       NEW.checksum            IS DISTINCT FROM OLD.checksum            OR
       NEW.received_at         IS DISTINCT FROM OLD.received_at         OR
       NEW.modified_at         IS DISTINCT FROM OLD.modified_at THEN
        RAISE EXCEPTION 'source_artifacts row % is immutable except status/processing_errors/sync_job_run_id', OLD.id
            USING ERRCODE = 'feature_not_supported';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_block_source_artifact_update ON source_artifacts;
CREATE TRIGGER trg_block_source_artifact_update
    BEFORE UPDATE ON source_artifacts
    FOR EACH ROW
    -- WHEN clause prevents the trigger from firing on mutable-only
    -- changes (status sweeps over 50K rows would otherwise hit it
    -- 50K times). LLD P0-3.
    WHEN (NEW.tenant_id           IS DISTINCT FROM OLD.tenant_id           OR
          NEW.merchant_id         IS DISTINCT FROM OLD.merchant_id         OR
          NEW.source_type         IS DISTINCT FROM OLD.source_type         OR
          NEW.source_marketplace  IS DISTINCT FROM OLD.source_marketplace  OR
          NEW.source_external_id  IS DISTINCT FROM OLD.source_external_id  OR
          NEW.parent_artifact_id  IS DISTINCT FROM OLD.parent_artifact_id  OR
          NEW.storage_uri         IS DISTINCT FROM OLD.storage_uri         OR
          NEW.raw_data            IS DISTINCT FROM OLD.raw_data            OR
          NEW.checksum            IS DISTINCT FROM OLD.checksum            OR
          NEW.received_at         IS DISTINCT FROM OLD.received_at         OR
          NEW.modified_at         IS DISTINCT FROM OLD.modified_at)
    EXECUTE FUNCTION block_source_artifact_mutation();

CREATE OR REPLACE FUNCTION block_source_artifact_delete()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'source_artifacts row % cannot be deleted (use GDPR purge with session_replication_role=replica)', OLD.id
        USING ERRCODE = 'feature_not_supported';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_block_source_artifact_delete ON source_artifacts;
CREATE TRIGGER trg_block_source_artifact_delete
    BEFORE DELETE ON source_artifacts
    FOR EACH ROW
    EXECUTE FUNCTION block_source_artifact_delete();

-- ----------------------------------------------------------------
-- audit_events: append-only. No UPDATE, no DELETE, full stop.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION block_audit_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only'
        USING ERRCODE = 'feature_not_supported';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_block_audit_update ON audit_events;
CREATE TRIGGER trg_block_audit_update
    BEFORE UPDATE ON audit_events
    FOR EACH ROW
    EXECUTE FUNCTION block_audit_mutation();

DROP TRIGGER IF EXISTS trg_block_audit_delete ON audit_events;
CREATE TRIGGER trg_block_audit_delete
    BEFORE DELETE ON audit_events
    FOR EACH ROW
    EXECUTE FUNCTION block_audit_mutation();

-- ----------------------------------------------------------------
-- product_versions: fully immutable (HLD §8.3).
-- The ONLY path to new System Truth is create proposed_diff → approve.
-- GDPR purge uses session_replication_role='replica' to bypass.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION block_product_version_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'product_versions row % is immutable (HLD §8.3). Create a proposed_diff and approve it.', OLD.id
        USING ERRCODE = 'feature_not_supported';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_block_product_version_update ON product_versions;
CREATE TRIGGER trg_block_product_version_update
    BEFORE UPDATE ON product_versions
    FOR EACH ROW
    EXECUTE FUNCTION block_product_version_mutation();

DROP TRIGGER IF EXISTS trg_block_product_version_delete ON product_versions;
CREATE TRIGGER trg_block_product_version_delete
    BEFORE DELETE ON product_versions
    FOR EACH ROW
    EXECUTE FUNCTION block_product_version_mutation();

-- ----------------------------------------------------------------
-- product_versions: enforce that proposed_diff_id points to an
-- approved or auto_approved diff (HLD §2.4 / spec rule 8).
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_product_version_diff_status()
RETURNS trigger AS $$
DECLARE
    diff_status text;
BEGIN
    SELECT status INTO diff_status
    FROM proposed_diffs
    WHERE id = NEW.proposed_diff_id;

    IF diff_status NOT IN ('approved', 'auto_approved') THEN
        RAISE EXCEPTION
            'product_versions.proposed_diff_id % must reference an approved or auto_approved diff (got: %)',
            NEW.proposed_diff_id, diff_status
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_check_product_version_diff ON product_versions;
CREATE TRIGGER trg_check_product_version_diff
    BEFORE INSERT ON product_versions
    FOR EACH ROW
    EXECUTE FUNCTION check_product_version_diff_status();
