-- TD Marketing: What's New for the team (dev job 9aec66fa, Addendum H, 28 Oct 2026). Antonio posts; Rocco and Ale read; he sees who read it.
-- Requires 20261018-0110-marketing-p1-db-lock.sql (marketing_teams and the lock). The value lists (audience, status) are checked in the server code, never by a CHECK here.
DO $$
BEGIN
  IF to_regclass('public.marketing_teams') IS NULL THEN
    RAISE EXCEPTION 'Run 20261018-0110-marketing-p1-db-lock.sql FIRST.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS marketing_news (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- null = every team (Antonio posts to all teams together)
  team_id      uuid REFERENCES marketing_teams(id) ON DELETE CASCADE,
  title        text NOT NULL,
  body         text NOT NULL,
  title_it     text,
  body_it      text,
  -- the menu key of the screen the post links to (the link itself is worked out when it is shown)
  link_key     text,
  audience     text NOT NULL DEFAULT 'everyone',
  -- set when the post came from a draft the system prepared for a new screen; one row per feature key, so a draft is decided once (posted or discarded)
  feature_key  text,
  status       text NOT NULL DEFAULT 'posted',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  posted_at    timestamptz,
  edited_at    timestamptz,
  withdrawn_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS marketing_news_feature_key_uq ON marketing_news (feature_key) WHERE feature_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS marketing_news_posted_idx ON marketing_news (status, posted_at DESC);

-- who opened which post (one row per person and post)
CREATE TABLE IF NOT EXISTS marketing_news_reads (
  news_id uuid NOT NULL REFERENCES marketing_news(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (news_id, user_id)
);

ALTER TABLE marketing_news ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_news_reads ENABLE ROW LEVEL SECURITY;

-- Every migration that creates a table ends with the standing lock (tests/unit/migrations-marketing-lock.test.ts enforces it).
SELECT public.marketing_lock_all_tables();
