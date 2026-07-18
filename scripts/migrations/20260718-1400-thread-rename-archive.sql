-- Team Workspace — thread ARCHIVE (reversible hide) + rename-aware lists.
--
-- Antonio 2026-07-18: "I can't delete or edit any threads anywhere." He chose
-- Archive/hide over true delete, with true delete reserved for a thread nobody
-- else has posted in.
--
-- Three things this closes:
--  1. ARCHIVE needs a DURABLE marker. "Removed = the state row is gone" was
--     rejected by the council: a single reply into such a thread resurrects it
--     on every board (the send route never checks the parent), and there is no
--     restore path from absence. `archived_at` is a positive fact that survives
--     replies and can be undone.
--  2. `list_followed_unread_threads` still titled rows from the ROOT MESSAGE
--     BODY, so a renamed thread leaked its old text into the Team Chat menu
--     dropdown while every other surface showed the new name. Same resolver as
--     `list_all_threads` now: state title first, message body as the fallback.
--  3. An archived thread must stop pulling attention — excluded from the
--     all-threads board AND from the followed-unread dot/dropdown.
--  4. A thread was listed on the board merely because a state ROW EXISTED. That
--     made any touch permanent: archive-then-restore, or set-then-unset a
--     status, left a stray one-line message on the board forever as a phantom
--     "thread" with no replies (council). Listing now keys on the row being
--     MEANINGFUL — named, archived, triaged, assigned, or deliberately created —
--     not on it merely existing. That also lets the write path stop deleting
--     rows to stay sparse, which is what kept silently reverting renames.
--
-- Wrapped in a transaction: the DROP + CREATE of list_all_threads below would
-- otherwise leave NO version of the function if the file half-runs.

BEGIN;

ALTER TABLE public.internal_thread_state
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid;

-- Archived threads are the minority; a partial index keeps the "hide these"
-- lookup on the channel GET cheap without paying for the common case.
CREATE INDEX IF NOT EXISTS idx_internal_thread_state_archived
  ON public.internal_thread_state (thread_id)
  WHERE archived_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Followed-unread threads (Team Chat menu dot + dropdown).
-- Body-only change: resolve the title the same way every other surface does,
-- and drop archived threads. Signature unchanged, so REPLACE is safe.
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
    -- SAME resolver as list_all_threads: an explicitly-named thread owns its
    -- title; a derived one falls back to the opening message, tombstone-safe.
    COALESCE(
      NULLIF(ts.title, ''),
      CASE WHEN root.deleted_at IS NOT NULL THEN 'Message deleted'
           ELSE COALESCE(NULLIF(root.message, ''), 'Attachment') END
    )                                                                    AS title,
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
  LEFT JOIN public.internal_thread_state ts ON ts.root_message_id = f.root_message_id
  LEFT JOIN public.internal_root_reads  rr
         ON rr.root_message_id = f.root_message_id AND rr.user_id = p_user_id
  WHERE f.user_id = p_user_id
    AND ts.archived_at IS NULL          -- an archived thread stops nagging
    AND EXISTS (
      SELECT 1
        FROM public.internal_messages m
       WHERE m.root_id = f.root_message_id
         AND m.deleted_at IS NULL
         AND m.sender_id <> p_user_id
         AND m.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz)
    );
$$;

-- ---------------------------------------------------------------------------
-- Cross-channel thread list (the Board) — gains an include-archived switch.
-- A new third parameter WITH a default would make the existing 2-arg call
-- ambiguous, so the old signature is dropped first (CREATE OR REPLACE cannot
-- change a signature).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.list_all_threads(uuid, integer);

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
  archived        boolean
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
      ts.archived_at,
      rr.last_read_at
    FROM public.internal_messages m
    JOIN public.internal_threads t
      ON t.id = m.thread_id AND t.thread_type IN ('channel', 'general') AND t.archived_at IS NULL
    LEFT JOIN public.internal_thread_state ts ON ts.root_message_id = m.id
    LEFT JOIN public.internal_root_reads  rr ON rr.root_message_id = m.id AND rr.user_id = p_user_id
    WHERE m.root_id IS NULL
      AND (p_include_archived OR ts.archived_at IS NULL)
      AND (
        -- MEANINGFUL state, not merely "a row exists" (see note 4 above).
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
             WHERE f.root_message_id = r.id AND f.user_id = p_user_id),
    (r.archived_at IS NOT NULL)
  FROM roots r
  ORDER BY 8 DESC
  LIMIT GREATEST(p_limit, 1);
$$;

COMMIT;
