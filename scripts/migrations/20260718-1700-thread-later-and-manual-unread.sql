-- Team Workspace — "bring forward" (Later) and "mark unread" on a single THREAD.
--
-- Antonio 2026-07-18: "I want to put any thread or message forward and read or
-- unread." Both actions already existed, but only on a WHOLE conversation
-- (internal_thread_reads.later / .manual_unread, set from the sidebar kebab).
-- Neither reached a thread inside a channel. This drops them one grain.
--
-- TWO DIFFERENT HOMES, deliberately:
--
--  • LATER gets its OWN sparse table, mirroring internal_root_follows and for
--    the same reason: internal_root_reads.last_read_at DEFAULTS to now(), so
--    flagging Later on a thread you have never opened would create a read row
--    that marks its existing replies READ. Presence of a row = flagged.
--
--  • MANUAL_UNREAD is genuinely read state, so it belongs on the read row —
--    same as the conversation-level column it mirrors. Creating that row to
--    mark a never-opened thread unread is harmless: it is already unread.
--
-- ⚠️ THREAD UNREAD IS READ IN THREE PLACES and they must agree, or the menu dot
-- and the lists disagree: computeThreadMeta (TS, panel + in-stream affordance),
-- list_all_threads (board), list_followed_unread_threads (menu dot + dropdown).
-- All three are updated here / alongside. Same class of hazard as the archive
-- bug on 2026-07-18e — treat every unread reader as a required update site.

BEGIN;

-- ---------------------------------------------------------------------------
-- LATER — personal, sparse, presence = flagged.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.internal_root_later (
  root_message_id uuid NOT NULL REFERENCES public.internal_messages(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (root_message_id, user_id)
);

-- The Later list is read per-user, newest first.
CREATE INDEX IF NOT EXISTS idx_internal_root_later_user
  ON public.internal_root_later (user_id, created_at DESC);

ALTER TABLE public.internal_root_later ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'internal_root_later'
       AND policyname = 'internal_root_later_staff_all'
  ) THEN
    CREATE POLICY internal_root_later_staff_all
      ON public.internal_root_later
      FOR ALL
      USING (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client')
      WITH CHECK (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client');
  END IF;
END $$;

-- Antonio works across a desktop and a phone PWA at once; flagging on one
-- should show on the other without a reload.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
       AND tablename = 'internal_root_later'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.internal_root_later;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- MANUAL UNREAD — mirrors internal_thread_reads.manual_unread one grain down.
-- Cleared when the thread pane is opened (the thread-read route).
-- ---------------------------------------------------------------------------
ALTER TABLE public.internal_root_reads
  ADD COLUMN IF NOT EXISTS manual_unread boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- The Later list itself — flagged threads across every channel, newest first.
-- Its own function because it is a personal, short, cross-channel list; folding
-- it into list_all_threads would mean pulling 300 rows to render a handful.
-- Returns the channel label so the sidebar can say WHERE each thread lives —
-- the Later list holds whole conversations AND single threads side by side, and
-- mixing grains without a label is exactly what made the Board confusing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_later_threads(p_user_id uuid)
RETURNS TABLE (
  root_message_id uuid,
  thread_id       uuid,
  channel_label   text,
  title           text,
  status          text,
  unread          boolean,
  flagged_at      timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    l.root_message_id,
    root.thread_id,
    COALESCE(t.channel_slug, t.channel_name, 'general'),
    COALESCE(
      NULLIF(ts.title, ''),
      CASE WHEN root.deleted_at IS NOT NULL THEN 'Message deleted'
           ELSE COALESCE(NULLIF(root.message, ''), 'Attachment') END
    ),
    COALESCE(ts.status, 'todo'),
    (
      COALESCE(rr.manual_unread, false)
      OR (root.sender_id <> p_user_id AND root.deleted_at IS NULL
          AND root.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz))
      OR EXISTS (
        SELECT 1 FROM public.internal_messages c
         WHERE c.root_id = l.root_message_id AND c.deleted_at IS NULL
           AND c.sender_id <> p_user_id
           AND c.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz)
      )
    ),
    l.created_at
  FROM public.internal_root_later l
  JOIN public.internal_messages root ON root.id = l.root_message_id
  JOIN public.internal_threads  t    ON t.id = root.thread_id
                                    AND t.thread_type IN ('channel', 'general')
  LEFT JOIN public.internal_thread_state ts ON ts.root_message_id = l.root_message_id
  LEFT JOIN public.internal_root_reads  rr  ON rr.root_message_id = l.root_message_id
                                           AND rr.user_id = p_user_id
  WHERE l.user_id = p_user_id
    AND ts.archived_at IS NULL      -- an archived thread is not "coming back"
  ORDER BY l.created_at DESC;
$$;

-- ---------------------------------------------------------------------------
-- Board list — honour manual_unread, and expose `later` so the ⋯ menu knows
-- whether to offer "Bring forward" or "Remove from Later".
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_all_threads(uuid, integer, boolean);

CREATE OR REPLACE FUNCTION public.list_all_threads(
  p_user_id uuid,
  p_limit integer DEFAULT 300,
  p_include_archived boolean DEFAULT false
)
RETURNS TABLE (
  root_message_id uuid,
  thread_id       uuid,
  channel_label   text,
  title           text,
  status          text,
  assignee_id     uuid,
  reply_count     integer,
  last_activity_at timestamptz,
  unread          boolean,
  following       boolean,
  archived        boolean,
  later           boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH roots AS (
    SELECT
      m.id, m.thread_id, m.message, m.sender_id, m.created_at, m.deleted_at,
      t.channel_slug, t.channel_name,
      ts.status, ts.assignee_id, ts.title AS state_title, ts.created_as_thread, ts.archived_at,
      rr.last_read_at, COALESCE(rr.manual_unread, false) AS manual_unread
    FROM public.internal_messages m
    JOIN public.internal_threads t
      ON t.id = m.thread_id AND t.thread_type IN ('channel', 'general') AND t.archived_at IS NULL
    LEFT JOIN public.internal_thread_state ts ON ts.root_message_id = m.id
    LEFT JOIN public.internal_root_reads  rr ON rr.root_message_id = m.id AND rr.user_id = p_user_id
    WHERE m.root_id IS NULL
      AND (p_include_archived OR ts.archived_at IS NULL)
      AND (
        ts.created_as_thread IS TRUE
        OR ts.title IS NOT NULL
        OR ts.archived_at IS NOT NULL
        OR ts.assignee_id IS NOT NULL
        OR ts.status IS DISTINCT FROM 'todo'
        OR EXISTS (SELECT 1 FROM public.internal_messages c
                    WHERE c.root_id = m.id AND c.deleted_at IS NULL)
      )
  )
  SELECT
    r.id,
    r.thread_id,
    COALESCE(r.channel_slug, r.channel_name, 'general'),
    COALESCE(
      NULLIF(r.state_title, ''),
      CASE WHEN r.deleted_at IS NOT NULL THEN 'Message deleted'
           ELSE COALESCE(NULLIF(r.message, ''), 'Attachment') END
    ),
    COALESCE(r.status, 'todo'),
    r.assignee_id,
    (SELECT COUNT(*)::int FROM public.internal_messages c
      WHERE c.root_id = r.id AND c.deleted_at IS NULL),
    GREATEST(
      r.created_at,
      COALESCE((SELECT MAX(c.created_at) FROM public.internal_messages c
                 WHERE c.root_id = r.id AND c.deleted_at IS NULL), r.created_at)
    ),
    -- New for me: manually marked unread, an unseen root from someone else, or
    -- an unseen other-reply.
    (
      r.manual_unread
      OR (r.sender_id <> p_user_id AND r.deleted_at IS NULL
          AND r.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz))
      OR EXISTS (
        SELECT 1 FROM public.internal_messages c
         WHERE c.root_id = r.id AND c.deleted_at IS NULL
           AND c.sender_id <> p_user_id
           AND c.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
      )
    ),
    EXISTS (SELECT 1 FROM public.internal_root_follows f
             WHERE f.root_message_id = r.id AND f.user_id = p_user_id),
    (r.archived_at IS NOT NULL),
    EXISTS (SELECT 1 FROM public.internal_root_later l
             WHERE l.root_message_id = r.id AND l.user_id = p_user_id)
  FROM roots r
  ORDER BY 8 DESC
  LIMIT GREATEST(p_limit, 1);
$$;

-- ---------------------------------------------------------------------------
-- Menu dot + dropdown — a followed thread you marked unread by hand must light
-- the dot too, even with no new replies. Signature unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_followed_unread_threads(p_user_id uuid)
RETURNS TABLE (
  root_message_id uuid,
  thread_id       uuid,
  thread_label    text,
  title           text,
  unread_count    integer,
  last_reply_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    f.root_message_id,
    root.thread_id,
    COALESCE(t.channel_slug, t.channel_name, 'general')                  AS thread_label,
    COALESCE(
      NULLIF(ts.title, ''),
      CASE WHEN root.deleted_at IS NOT NULL THEN 'Message deleted'
           ELSE COALESCE(NULLIF(root.message, ''), 'Attachment') END
    )                                                                    AS title,
    -- A hand-marked thread with no new replies still counts as one, so the
    -- dropdown row is never labelled "0".
    GREATEST(
      (SELECT COUNT(*)::int
         FROM public.internal_messages m
        WHERE m.root_id = f.root_message_id
          AND m.deleted_at IS NULL
          AND m.sender_id <> p_user_id
          AND m.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz)),
      CASE WHEN COALESCE(rr.manual_unread, false) THEN 1 ELSE 0 END
    )                                                                    AS unread_count,
    (SELECT MAX(m.created_at)
       FROM public.internal_messages m
      WHERE m.root_id = f.root_message_id
        AND m.deleted_at IS NULL
        AND m.sender_id <> p_user_id
        AND m.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz)) AS last_reply_at
  FROM public.internal_root_follows f
  JOIN public.internal_messages root ON root.id = f.root_message_id
  JOIN public.internal_threads  t    ON t.id = root.thread_id
                                    AND t.thread_type IN ('channel', 'general')
  LEFT JOIN public.internal_thread_state ts ON ts.root_message_id = f.root_message_id
  LEFT JOIN public.internal_root_reads  rr
         ON rr.root_message_id = f.root_message_id AND rr.user_id = p_user_id
  WHERE f.user_id = p_user_id
    AND ts.archived_at IS NULL
    AND (
      COALESCE(rr.manual_unread, false)
      OR EXISTS (
        SELECT 1
          FROM public.internal_messages m
         WHERE m.root_id = f.root_message_id
           AND m.deleted_at IS NULL
           AND m.sender_id <> p_user_id
           AND m.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz)
      )
    );
$$;

COMMIT;
