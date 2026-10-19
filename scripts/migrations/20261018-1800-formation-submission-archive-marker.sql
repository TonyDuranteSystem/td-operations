-- Formation-submission filing marker (Stop-Drive S1a, 2026-10-18, dev job 264bb882).
--
-- The lead-stage formation form now files its summary + uploads in the client's STORAGE. Like closure / ITIN / banking, it gets the
-- durable retry path: a marker the job and the sweep can query, so a failed or timed-out filing is retried and finally ALERTED, never
-- silently missing. (onboarding_submissions already has both columns.) The column names keep the historical "drive_" prefix because the
-- shared archive engine reads them by name for every form.
ALTER TABLE formation_submissions
  ADD COLUMN IF NOT EXISTS drive_archived_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS drive_archive_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN formation_submissions.drive_archived_at IS
  'Set ONLY on a fully-successful filing (summary + all files in the client storage). NULL = never filed / partial / failed — the forms archive sweep re-runs these.';
COMMENT ON COLUMN formation_submissions.drive_archive_meta IS
  'Last filing attempt detail + values pinned at submission: { attempts, last_error, last_attempt_at, copied, failed, errors, pinned_plan }.';

CREATE INDEX IF NOT EXISTS idx_formation_submissions_unfiled
  ON formation_submissions (created_at)
  WHERE drive_archived_at IS NULL;
