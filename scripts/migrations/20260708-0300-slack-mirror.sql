-- Team Workspace — Slack channel mirror (read-only feed).
-- Ingests messages from the Slack channels the bot is in (via the events already
-- arriving at the Slack webhook + a conversations.history backfill) into our own
-- Postgres, so the workspace can show Slack channels with "Open in Slack" links
-- without hammering the Slack API on every render. Ships DORMANT behind the
-- app_settings 'slack_mirror_enabled' flag (default off). Internal for a
-- single-workspace app → ToS-compliant to store (no LLM training on it).
-- Additive; staff-only RLS matching the internal_* tables.

BEGIN;

CREATE TABLE IF NOT EXISTS public.slack_channels (
  id              text PRIMARY KEY,          -- Slack channel id (e.g. C0BAB08DSDN)
  name            text,
  is_private      boolean NOT NULL DEFAULT false,
  is_member       boolean NOT NULL DEFAULT false,
  is_archived     boolean NOT NULL DEFAULT false,
  topic           text,
  num_members     integer,
  last_message_at timestamptz,
  synced_at       timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.slack_messages (
  channel_id    text NOT NULL,
  ts            text NOT NULL,               -- Slack message ts ("1782141518.486979")
  thread_ts     text,                        -- parent ts when this is a thread reply
  slack_user_id text,
  author_name   text,
  text          text,
  subtype       text,
  deleted       boolean NOT NULL DEFAULT false,
  edited        boolean NOT NULL DEFAULT false,
  posted_at     timestamptz,                 -- derived from ts
  raw           jsonb,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_slack_messages_feed
  ON public.slack_messages (channel_id, posted_at DESC)
  WHERE deleted = false;

CREATE INDEX IF NOT EXISTS idx_slack_messages_thread
  ON public.slack_messages (channel_id, thread_ts)
  WHERE thread_ts IS NOT NULL;

-- Staff-only RLS (match internal_* / prod convention). App routes use
-- supabaseAdmin (bypass) after a staff auth check; this guards direct access.
ALTER TABLE public.slack_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_messages ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='slack_channels' AND policyname='slack_channels_staff_all') THEN
    CREATE POLICY slack_channels_staff_all ON public.slack_channels FOR ALL
      USING (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client')
      WITH CHECK (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='slack_messages' AND policyname='slack_messages_staff_all') THEN
    CREATE POLICY slack_messages_staff_all ON public.slack_messages FOR ALL
      USING (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client')
      WITH CHECK (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client');
  END IF;
END $$;

COMMIT;
