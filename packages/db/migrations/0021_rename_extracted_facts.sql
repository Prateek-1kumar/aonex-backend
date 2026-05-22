-- Catalog redesign Phase 9, Task 9.2 — rename extracted_facts* tables.
--
-- After Phase 9.1 dropped the legacy catalog tables, these renames complete
-- the rebranding: the tables formerly known as "extracted_facts" are now
-- the link-ingestion trace (Phase 9 reframing — they're transient evidence
-- of LLM extraction during link ingestion, NOT canonical catalog state).
--
-- 14-day retention is enforced by a daily worker job (apps/worker/src/jobs/
-- link-trace-cleanup.ts). The job DELETEs rows older than 14 days; the schema
-- retains no FK CASCADE so the cleanup is straightforward.
--
-- See spec §22 and plan §9.2.
--
-- NOTE: Indexes carry over the rename automatically — Postgres ALTER TABLE RENAME
-- preserves index names. The old idx_extracted_facts_* / idx_extracted_fact_sets_*
-- / idx_extraction_runs_* names will survive until a future cosmetic migration.
-- Renaming indexes requires ACCESS EXCLUSIVE lock; deferred deliberately to
-- avoid contention during the apply window.
--
-- PREREQUISITE: Task 9.1 (drop legacy catalog tables) must be applied first.
-- This migration fails loudly if the source tables do not exist — that's
-- intentional (fail loud > silent success on wrong state).

ALTER TABLE extraction_runs     RENAME TO link_ingestion_trace_runs;
ALTER TABLE extracted_fact_sets RENAME TO link_ingestion_trace_sets;
ALTER TABLE extracted_facts     RENAME TO link_ingestion_trace_facts;
