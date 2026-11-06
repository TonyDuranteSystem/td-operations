-- TD Marketing: a team can be marked as a TEST team (dev job 9aec66fa, 6 Nov 2026). A test team never receives real leads: lead intake skips it, "give this lead a team" refuses it and does not list it,
-- and it is not counted when intake looks for "the only active team". Why: on 5 Nov 2026 two real leads got no team because the leftover "ZZ TEST team" was still active next to Rocco's team.
-- Requires 20261018-0110-marketing-p1-db-lock.sql (marketing_teams).
DO $$
BEGIN
  IF to_regclass('public.marketing_teams') IS NULL THEN
    RAISE EXCEPTION 'Run 20261018-0110-marketing-p1-db-lock.sql FIRST.';
  END IF;
END $$;

ALTER TABLE marketing_teams ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

-- The one existing test team, by its exact name (no pattern). Nothing happens where it does not exist.
UPDATE marketing_teams SET is_test = true WHERE name = 'ZZ TEST team (delete me)' AND is_test = false;
