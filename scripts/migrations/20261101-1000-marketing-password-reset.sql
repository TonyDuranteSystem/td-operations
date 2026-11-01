-- TD Marketing: a one-time link that lets a team member choose a new password (dev job 9aec66fa).
-- Two ways to get one: the person asks for it himself ("Forgot password?", emailed to HIS address) or a team owner makes it from the Team page and sends it.
-- Only the HASH of the link's token is stored. A link works once, expires, and can be cancelled by making a new one.
-- Requires 20261018-0110-marketing-p1-db-lock.sql (marketing_teams and the lock).
DO $$
BEGIN
  IF to_regclass('public.marketing_teams') IS NULL THEN
    RAISE EXCEPTION 'Run 20261018-0110-marketing-p1-db-lock.sql FIRST.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketing_password_resets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id              uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL,                      -- the login whose password the link changes
  email_lower          text NOT NULL,
  token_hash           text NOT NULL UNIQUE,               -- only the hash is stored; the link carries the token
  expires_at           timestamptz NOT NULL,
  used_at              timestamptz,
  revoked_at           timestamptz,
  requested_by         text NOT NULL,                      -- 'self' (Forgot password) or the email of the owner / Antonio who made the link
  requested_by_user_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);
-- at most ONE open link per login: a new link cancels the earlier one
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_password_resets_open
  ON marketing_password_resets (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;
-- the hourly limits count recent rows per login
CREATE INDEX IF NOT EXISTS ix_marketing_password_resets_user_recent
  ON marketing_password_resets (user_id, created_at DESC);

ALTER TABLE marketing_password_resets ENABLE ROW LEVEL SECURITY;

-- Every migration that creates a table ends with the standing lock (tests/unit/migrations-marketing-lock.test.ts enforces it).
SELECT public.marketing_lock_all_tables();
