-- Workflow Editor Phase 6 — add 'draft' to catalog_entries.status check constraint.
--
-- Why: the editor's Save Draft action writes a workflow row with status='draft'
-- so it persists across sessions but doesn't fire in production (the dispatcher
-- filters .eq('status', 'active')). Publish flips status to 'active' once the
-- validity gate passes.
--
-- Idempotent: drops the existing constraint by name (we already know the name
-- from information_schema), then recreates with the expanded set. Re-running
-- the migration is a no-op (constraint definition matches the desired state).

BEGIN;

ALTER TABLE catalog_entries
  DROP CONSTRAINT IF EXISTS catalog_entries_status_check;

ALTER TABLE catalog_entries
  ADD CONSTRAINT catalog_entries_status_check
  CHECK (status = ANY (ARRAY['active'::text, 'deprecated'::text, 'exception_only'::text, 'draft'::text]));

COMMIT;
