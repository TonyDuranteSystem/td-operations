-- TD Marketing: Zoom recordings saved into the CRM storage (dev job 9aec66fa, 4 Nov 2026). One row per Zoom recording FILE, so a file is never saved twice (even if someone moves or renames it in storage afterwards).
-- A row is written FIRST with status 'saving' (the primary key makes two overlapping runs fight for the file, only one wins), then marked 'saved' with the storage file; a failed save deletes the row so the next run tries again.
-- No CHECK lists on purpose (a new CHECK on the shared sandbox turns other sessions' CI red): the words are kept by the code.
-- Requires 20261018-0110-marketing-p1-db-lock.sql (marketing_teams and the lock).
DO $$
BEGIN
  IF to_regclass('public.marketing_teams') IS NULL THEN
    RAISE EXCEPTION 'Run 20261018-0110-marketing-p1-db-lock.sql FIRST.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketing_zoom_recordings (
  zoom_file_id   text PRIMARY KEY,
  team_id        uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE CASCADE,
  host           text NOT NULL,
  meeting_id     text,
  meeting_uuid   text,
  topic          text,
  started_at     timestamptz,
  file_type      text,
  recording_type text,
  size_bytes     bigint,
  status         text NOT NULL DEFAULT 'saving',
  store_file_id  uuid,
  claimed_at     timestamptz NOT NULL DEFAULT now(),
  saved_at       timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketing_zoom_recordings_team_idx ON marketing_zoom_recordings (team_id, saved_at DESC);

ALTER TABLE marketing_zoom_recordings ENABLE ROW LEVEL SECURITY;

-- Every migration that creates a table ends with the standing lock (tests/unit/migrations-marketing-lock.test.ts enforces it).
SELECT public.marketing_lock_all_tables();
