-- Catalog enrichment Phase 3 — staged Drafting Room workflow.
-- reviewed_at splits the workspace: a pending/generating/ready proposal with
-- reviewed_at IS NULL lives in the Drafting Room; once the user "sends to Review
-- Commit" (saving per-field decisions) reviewed_at is stamped and it moves to the
-- Review Commit view; applying it ("Sync to Catalog") flips status to 'applied'.

ALTER TABLE enrichment_proposals
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
