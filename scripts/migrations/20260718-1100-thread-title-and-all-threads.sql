-- Team Workspace — explicitly-created threads (own title + durable marker) and
-- the cross-channel All-Threads board.
--
-- Two council blockers this closes:
--  1. EXISTENCE: a thread's presence in the list was encoded as "has a non-default
--     status row" — but the status endpoint DELETEs that row on revert-to-default
--     (sparse rule). A deliberately-created topic left at Open with no replies
--     therefore vanished. `created_as_thread` makes existence DECLARED, not
--     inferred, and the delete path must respect it.
--  2. NAME: the title was the root message body, so editing that message renamed
--     the topic and soft-deleting it renamed it "Message deleted" forever. An
--     explicit thread now carries its own `title`; derived threads still fall back
--     to the message body (Slack behaviour) via one shared resolver.

ALTER TABLE public.internal_thread_state
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS created_as_thread boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Cross-channel thread list (the Board). One row per thread across every
-- channel/general the caller can see. Bounded: newest activity first + a cap,
-- so it can never become an unbounded scan as threads accumulate.
--
-- Unread here counts the ROOT MESSAGE too, not just replies: a brand-new thread
-- someone else opened must show as New (bold + dot) even before anyone replies —
-- otherwise "+ New thread" can't get a teammate's attention. Guards mirrored from
-- the rest of the unread model: per-ROOT read pointer (never the channel
-- pointer), deleted_at IS NULL, sender <> caller, channel/general only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_all_threads(p_user_id uuid, p_limit integer DEFAULT 300)
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
  following       boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH roots AS (
    SELECT
      m.id,
      m.thread_id,
      m.message,
      m.sender_id,
      m.created_at,
      m.deleted_at,
      t.channel_slug,
      t.channel_name,
      ts.status,
      ts.assignee_id,
      ts.title            AS state_title,
      ts.created_as_thread,
      rr.last_read_at
    FROM public.internal_messages m
    JOIN public.internal_threads t
      ON t.id = m.thread_id AND t.thread_type IN ('channel', 'general') AND t.archived_at IS NULL
    LEFT JOIN public.internal_thread_state ts ON ts.root_message_id = m.id
    LEFT JOIN public.internal_root_reads  rr ON rr.root_message_id = m.id AND rr.user_id = p_user_id
    WHERE m.root_id IS NULL
      AND (
        ts.created_as_thread IS TRUE
        OR ts.root_message_id IS NOT NULL
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
    -- New for me: an unseen root from someone else, or an unseen other-reply.
    (
      (r.sender_id <> p_user_id AND r.deleted_at IS NULL
        AND r.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz))
      OR EXISTS (
        SELECT 1 FROM public.internal_messages c
         WHERE c.root_id = r.id AND c.deleted_at IS NULL
           AND c.sender_id <> p_user_id
           AND c.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
      )
    ),
    EXISTS (SELECT 1 FROM public.internal_root_follows f
             WHERE f.root_message_id = r.id AND f.user_id = p_user_id)
  FROM roots r
  ORDER BY 8 DESC
  LIMIT GREATEST(p_limit, 1);
$$;
