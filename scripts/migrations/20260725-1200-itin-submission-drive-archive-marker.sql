-- ITIN-submission Google Drive archival marker (2026-07-25).
--
-- Extends the durable-archival reliability pattern (tax 20260724-1900, banking
-- 20260724-2100) to ITIN, the second non-tax form. Same truth model: an
-- "archived?" record a durable job + backstop sweep can query, so a failed/
-- timed-out Drive copy is never silently missing.
--
-- drive_archived_at is set ONLY on a FULLY successful archival (summary PDF +
-- every uploaded file copied into the resolved CONTACT folder). Partial/failed
-- leaves it NULL so the sweep re-runs it.
--
-- drive_archive_meta carries the last attempt's detail AND the values PINNED at
-- submission (resolved contact-folder id, bucket, config key, upload paths).
-- ITIN files under the PERSON, never the company's main area: a company-owner's
-- ITIN goes in their company's "2. Contacts" subfolder; an individual's goes
-- under "Individual Clients". The resolved folder id is pinned so the durable
-- job never re-derives it from a mutable name.

ALTER TABLE itin_submissions
  ADD COLUMN IF NOT EXISTS drive_archived_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS drive_archive_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN itin_submissions.drive_archived_at IS
  'Set ONLY on a fully-successful Drive archival (summary + all files into the resolved contact folder). NULL = never archived / partial / failed — the forms-archive sweep re-runs these.';
COMMENT ON COLUMN itin_submissions.drive_archive_meta IS
  'Last archival attempt detail + values pinned at submission: { attempts, last_error, last_attempt_at, copied, failed, errors, drive_folder_id, bucket, config_key, upload_paths }.';

CREATE INDEX IF NOT EXISTS idx_itin_submissions_unarchived
  ON itin_submissions (created_at)
  WHERE drive_archived_at IS NULL;
