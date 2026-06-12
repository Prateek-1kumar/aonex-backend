-- Seed the default active policy_version (v1).
--
-- The ingestion spine's orchestrator calls ensureActivePolicy() right before the
-- score stage (orchestrator.ts) and THROWS "No active policy_version configured"
-- when no active row exists. Every link/CSV job then dies after validate → no
-- score/diff/approve → 0 facts persisted → BullMQ retries → stuck PROCESSING.
--
-- policy.ts documents the intent ("Phase 1 ships the table + seeds the default
-- v1 row so audit rows can reference a policy_version from day one") but no seed
-- ever shipped, so a fresh DB (e.g. `docker compose down -v && db:migrate:up`)
-- has an empty table and link ingestion is dead on arrival. This data migration
-- closes that gap.
--
-- scoring_weights is not read by runtime code yet (route() and the semantic
-- mapper use fixed in-code weights; the column is reserved for Phase 3+). The
-- values below mirror MAPPING_WEIGHTS for fidelity. Thresholds use the schema
-- defaults (auto_approve 0.90, anomaly/reject 0.55).
--
-- Idempotent: version is UNIQUE (uq_policy_version), so re-running is a no-op.

INSERT INTO policy_versions (version, scoring_weights, active)
VALUES (
  'v1',
  '{
     "channelMapping": 0.40,
     "synonym": 0.18,
     "embedding": 0.15,
     "typeCompat": 0.10,
     "unitCompat": 0.07,
     "categoryCompat": 0.06,
     "tenantCorrection": 0.04
   }'::jsonb,
  true
)
ON CONFLICT (version) DO NOTHING;
