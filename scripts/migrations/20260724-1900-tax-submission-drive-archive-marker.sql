-- Tax-submission Google Drive archival: a truthful, self-healable "archived?" record.
--
-- WHY: today "has this submission been archived to Drive?" exists only as a step
-- line inside job_queue.result. Nothing can query "what was never archived", so
-- a failed/skipped/timed-out Drive copy stays silently missing (Matteo Carasso,
-- 2026-07-24). This adds the single source of truth the durable archive job +
-- backstop sweep key on.
--
-- drive_archived_at is set ONLY on a FULLY successful archival (summary saved AND
-- every file copied AND the correct 3.Tax/{year} folder resolved). Partial or
-- misfiled never counts as done — the sweep re-runs anything still NULL.
--
-- drive_archive_meta carries the last attempt's detail (counts, folder id,
-- attempt number, last error, timestamp) so a failure is inspectable and the
-- sweep can enforce an attempt cap without a separate table.

ALTER TABLE tax_return_submissions
  ADD COLUMN IF NOT EXISTS drive_archived_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS drive_archive_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN tax_return_submissions.drive_archived_at IS
  'Set ONLY on a fully-successful Drive archival (summary + all files, correct year folder). NULL = never archived / partial / failed — the archive sweep re-runs these.';
COMMENT ON COLUMN tax_return_submissions.drive_archive_meta IS
  'Last archival attempt detail: { attempts, last_error, last_attempt_at, copied, failed, errors, folder_id }. For inspection + the sweep attempt cap.';

-- Sweep anchor: find never-archived submissions cheaply. Partial index keeps it
-- tiny (only the un-archived rows) and self-shrinking as rows get archived.
CREATE INDEX IF NOT EXISTS idx_tax_submissions_unarchived
  ON tax_return_submissions (created_at)
  WHERE drive_archived_at IS NULL;
