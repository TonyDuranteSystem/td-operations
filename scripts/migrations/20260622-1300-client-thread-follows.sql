-- Client Threads — per-user "Follow" + personal DM digest (dev_task 54f89912).
--
-- WHY: Slack gives apps no API to follow a thread or add to "Later" on a user's
-- behalf (verified 2026-06-22 in Slack docs). So "follow this conversation until it
-- closes" is tracked HERE. A 👀 Follow button on the 🗂️ folder message toggles a row
-- in client_thread_follows for the clicking user; the bot keeps ONE message in that
-- user's DM (tracked in slack_follow_digests) listing their followed + still-open
-- conversations, each a clickable permalink. A closed conversation drops off because
-- the digest query filters client_threads.status = 'open'.

-- Per-user follow of a client conversation.
CREATE TABLE IF NOT EXISTS public.client_thread_follows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_thread_id uuid NOT NULL REFERENCES public.client_threads(id) ON DELETE CASCADE,
  slack_user_id    text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_thread_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS client_thread_follows_user_idx   ON public.client_thread_follows (slack_user_id);
CREATE INDEX IF NOT EXISTS client_thread_follows_thread_idx ON public.client_thread_follows (client_thread_id);

-- The single DM "📌 Following" message we keep updated per user (chat.update by ts),
-- so refreshes edit one message instead of spamming a new DM each time.
CREATE TABLE IF NOT EXISTS public.slack_follow_digests (
  slack_user_id text PRIMARY KEY,
  dm_channel_id text,
  message_ts    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- RLS: enable with NO policies → denies all anon/authenticated PostgREST access.
-- Internal/staff-only; every read/write goes through the service role (supabaseAdmin),
-- which bypasses RLS. Mirrors client_threads.
ALTER TABLE public.client_thread_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_follow_digests  ENABLE ROW LEVEL SECURITY;
