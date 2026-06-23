-- Follow ANY Slack thread via 👀 + a per-channel "Followed conversations" Canvas.
--
-- Distinct from client_threads (which are client+topic tagged /client cards): this lets
-- a user 👀-react on ANY thread (even a plain @Claude question) to track it, and each
-- channel gets its own Canvas of the threads followed there. (dev_task 54f89912.)

-- A per-user follow of an arbitrary Slack thread.
CREATE TABLE IF NOT EXISTS public.slack_thread_follows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    text NOT NULL,
  thread_ts     text NOT NULL,
  slack_user_id text NOT NULL,
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, thread_ts, slack_user_id)
);

CREATE INDEX IF NOT EXISTS slack_thread_follows_channel_idx ON public.slack_thread_follows (channel_id);

-- One maintained "Followed conversations" Canvas per channel (id stored once → no
-- duplicate-create bug). Created lazily the first time a channel has a followed thread.
CREATE TABLE IF NOT EXISTS public.slack_channel_canvas (
  channel_id text PRIMARY KEY,
  canvas_id  text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS: internal/staff-only; all access via the service role (supabaseAdmin), like
-- client_threads. Enable with no policies → denies anon/authenticated PostgREST.
ALTER TABLE public.slack_thread_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_channel_canvas ENABLE ROW LEVEL SECURITY;
