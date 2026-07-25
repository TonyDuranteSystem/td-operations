-- Banking-submission Google Drive archival marker (2026-07-24).
--
-- Extends the tax durable-archival reliability pattern (migration 20260724-1900)
-- to banking, the FIRST of the five other forms. Same truth model: an "archived?"
-- record that a durable job + backstop sweep can query, so a failed/timed-out
-- Drive copy is never silently missing (the Carasso failure mode).
--
-- drive_archived_at is set ONLY on a FULLY successful archival (summary PDF saved
-- AND every uploaded file copied into the resolved folder). Partial/misfiled/failed
-- leaves it NULL so the sweep re-runs it.
--
-- drive_archive_meta carries the last attempt's detail AND the values PINNED at
-- submission time (resolved folder id, storage bucket, form config key, upload
-- paths) — banking has two submission origins (external form → banking-uploads /
-- config "banking"; portal wizard payset/relay → onboarding-uploads / config
-- banking_payset|banking_relay) and the wizard update does not persist upload_paths
-- on the row, so the enqueue pins everything here rather than re-deriving it later.

ALTER TABLE banking_submissions
  ADD COLUMN IF NOT EXISTS drive_archived_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS drive_archive_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN banking_submissions.drive_archived_at IS
  'Set ONLY on a fully-successful Drive archival (summary + all files into the resolved account folder). NULL = never archived / partial / failed — the forms-archive sweep re-runs these.';
COMMENT ON COLUMN banking_submissions.drive_archive_meta IS
  'Last archival attempt detail + values pinned at submission: { attempts, last_error, last_attempt_at, copied, failed, errors, drive_folder_id, bucket, config_key, upload_paths, origin }. For inspection + the sweep attempt cap + deferred-archival folder/bucket stability.';

-- Sweep anchor: find never-archived banking submissions cheaply. Partial index
-- stays tiny (only un-archived rows) and self-shrinks as rows archive.
CREATE INDEX IF NOT EXISTS idx_banking_submissions_unarchived
  ON banking_submissions (created_at)
  WHERE drive_archived_at IS NULL;
