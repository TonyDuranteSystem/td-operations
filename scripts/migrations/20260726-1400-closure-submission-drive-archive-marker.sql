-- Closure-submission Google Drive archival marker (2026-07-26).
--
-- Extends the durable-archival reliability pattern (tax, banking, itin) to
-- closure, the last of the fragile at-submission forms. Same truth model: an
-- "archived?" record a durable job + backstop sweep can query, so a failed/
-- timed-out best-effort Drive copy is never silently missing.
--
-- Closure files where it files TODAY, just reliably: the company folder when the
-- submission is linked to an account with a Drive folder, else a deterministic
-- closure-named folder under Leads ("{client} - {llc} (Closure)"). The resolved
-- folder id is pinned so the durable job never re-derives it.

ALTER TABLE closure_submissions
  ADD COLUMN IF NOT EXISTS drive_archived_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS drive_archive_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN closure_submissions.drive_archived_at IS
  'Set ONLY on a fully-successful Drive archival (summary + all files into the resolved folder). NULL = never archived / partial / failed — the forms-archive sweep re-runs these.';
COMMENT ON COLUMN closure_submissions.drive_archive_meta IS
  'Last archival attempt detail + values pinned at submission: { attempts, last_error, last_attempt_at, copied, failed, errors, drive_folder_id, bucket, config_key, upload_paths }.';

CREATE INDEX IF NOT EXISTS idx_closure_submissions_unarchived
  ON closure_submissions (created_at)
  WHERE drive_archived_at IS NULL;
