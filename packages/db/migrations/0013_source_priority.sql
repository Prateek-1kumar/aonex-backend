-- Catalog redesign Phase 1, Task 1.7 — source_priority rules table.
-- Effective-dated rules that decide which source wins for each attribute.
-- Tenant-scoped or global (NULL tenant_id = global default). Tombstoning
-- is done by setting effective_to = now(); active rules have effective_to IS NULL.
-- The lookup index is a PARTIAL index over active rules only — that's the
-- key feature of the schema. See spec §5.

CREATE TABLE source_priority (
  rule_id          BIGSERIAL PRIMARY KEY,
  tenant_id        UUID,                  -- NULL = global default
  attribute_code   TEXT,                  -- NULL = applies to all attributes
  source_glob      TEXT NOT NULL,
  channel_scope    TEXT,
  priority         INTEGER NOT NULL,
  predicate        JSONB,                 -- nullable JSONLogic for conditional rules (v2)
  rules_version    INT NOT NULL,
  effective_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to     TIMESTAMPTZ,           -- NULL = currently in force
  actor            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_source_priority_lookup
  ON source_priority (tenant_id, attribute_code, source_glob, channel_scope)
  WHERE effective_to IS NULL;
