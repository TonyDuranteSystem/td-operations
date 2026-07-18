-- Team Workspace — per-person thread FOLLOW.
--
-- Presence of a row = this user follows this thread (root). Following is the
-- SINGLE source of truth for who gets pinged on a channel thread reply — it
-- REPLACES the old "push every prior participant" heuristic, so Unfollow finally
-- works. Its own table (not a flag on internal_root_reads) so following never
-- touches last_read_at (following a thread you haven't opened must NOT mark its
-- existing replies read) — same "separate sparse table per concern" pattern as
-- internal_thread_state. Follow = INSERT ON CONFLICT DO NOTHING; Unfollow = DELETE.

CREATE TABLE IF NOT EXISTS public.internal_root_follows (
  root_message_id uuid NOT NULL REFERENCES public.internal_messages(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_root_follows_user
  ON public.internal_root_follows (user_id);

ALTER TABLE public.internal_root_follows ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'internal_root_follows'
       AND policyname = 'internal_root_follows_staff_all'
  ) THEN
    CREATE POLICY internal_root_follows_staff_all
      ON public.internal_root_follows
      FOR ALL
      USING (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client')
      WITH CHECK (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
       AND tablename = 'internal_root_follows'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.internal_root_follows;
  END IF;
END $$;

-- Backfill: seed followers from the EXISTING participants of every channel/general
-- thread (root authors + everyone who replied), excluding the Claude sentinel, so
-- live threads keep pinging their people after the switch to follow-based push.
INSERT INTO public.internal_root_follows (root_message_id, user_id)
SELECT DISTINCT x.root, x.sender
FROM (
  -- root authors of roots that actually have a reply
  SELECT r.id AS root, r.sender_id AS sender
    FROM public.internal_messages r
    JOIN public.internal_threads t ON t.id = r.thread_id AND t.thread_type IN ('channel', 'general')
   WHERE r.root_id IS NULL
     AND EXISTS (SELECT 1 FROM public.internal_messages c WHERE c.root_id = r.id AND c.deleted_at IS NULL)
  UNION
  -- everyone who replied
  SELECT m.root_id AS root, m.sender_id AS sender
    FROM public.internal_messages m
    JOIN public.internal_threads t ON t.id = m.thread_id AND t.thread_type IN ('channel', 'general')
   WHERE m.root_id IS NOT NULL AND m.deleted_at IS NULL
) x
WHERE x.sender IS NOT NULL
  AND x.sender <> '00000000-0000-0000-0000-00000000c1a1'
ON CONFLICT DO NOTHING;
