-- Team Workspace — followed-unread threads for the Team Chat menu signal.
--
-- Powers the top-level Team Chat dot (and its dropdown) for Slack-style threads:
-- "threads I FOLLOW that have a reply from someone else I haven't read".
--
-- Deliberately its own function rather than widening get_team_threads: follow +
-- unread live at the ROOT-MESSAGE grain, while get_team_threads is whole-thread
-- grain. Replicates the four guards the rest of the unread model uses:
--   1. the PER-ROOT read pointer (internal_root_reads) — NOT the channel pointer,
--      so opening the channel never clears an unopened thread's unread;
--   2. deleted_at IS NULL (soft-deleted replies don't keep a dot alive);
--   3. sender <> the caller (your own replies never mark your thread unread);
--   4. channel/general only (DMs + client discussions have their own signals).
-- One row per followed thread with unread replies: the count drives the dot, the
-- rows drive the dropdown list.

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
    CASE WHEN root.deleted_at IS NOT NULL THEN 'Message deleted'
         ELSE COALESCE(NULLIF(root.message, ''), 'Attachment') END        AS title,
    (SELECT COUNT(*)::int
       FROM public.internal_messages m
      WHERE m.root_id = f.root_message_id
        AND m.deleted_at IS NULL
        AND m.sender_id <> p_user_id
        AND m.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz)) AS unread_count,
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
  LEFT JOIN public.internal_root_reads rr
         ON rr.root_message_id = f.root_message_id AND rr.user_id = p_user_id
  WHERE f.user_id = p_user_id
    AND EXISTS (
      SELECT 1
        FROM public.internal_messages m
       WHERE m.root_id = f.root_message_id
         AND m.deleted_at IS NULL
         AND m.sender_id <> p_user_id
         AND m.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz)
    );
$$;

-- Keeps the badge poll cheap: probe replies by their thread root.
CREATE INDEX IF NOT EXISTS idx_internal_messages_root_only
  ON public.internal_messages (root_id)
  WHERE root_id IS NOT NULL AND deleted_at IS NULL;
