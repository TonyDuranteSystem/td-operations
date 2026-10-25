-- TD Marketing: the guided tour is remembered per person (dev job 9aec66fa), and an invitation remembers that it was emailed.
-- Requires 20261018-0110-marketing-p1-db-lock.sql (marketing_teams, marketing_invites and the lock).
DO $$
BEGIN
  IF to_regclass('public.marketing_invites') IS NULL OR to_regclass('public.marketing_teams') IS NULL THEN
    RAISE EXCEPTION 'Run 20261018-0110-marketing-p1-db-lock.sql FIRST.';
  END IF;
END $$;

-- one row per person, team and tour (setter, seller, content, analyst or owner): the tour was finished or skipped, so it does not start again by itself
CREATE TABLE IF NOT EXISTS marketing_tour_seen (
  user_id  uuid NOT NULL,
  team_id  uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE CASCADE,
  tour_key text NOT NULL CHECK (length(btrim(tour_key)) BETWEEN 1 AND 40),
  status   text NOT NULL CHECK (status IN ('done', 'skipped')),
  seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, team_id, tour_key)
);

-- the invitation was sent by email from the CRM (who pressed Send, and when); the link itself is never stored, only its hash
ALTER TABLE marketing_invites ADD COLUMN IF NOT EXISTS emailed_at timestamptz;
ALTER TABLE marketing_invites ADD COLUMN IF NOT EXISTS emailed_by text;

ALTER TABLE marketing_tour_seen ENABLE ROW LEVEL SECURITY;

-- Every migration that creates a table ends with the standing lock (tests/unit/migrations-marketing-lock.test.ts enforces it).
SELECT public.marketing_lock_all_tables();
