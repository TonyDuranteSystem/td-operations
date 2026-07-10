-- Team Workspace S2 — client-conversation resolution (Solved / Closed).
--
-- Adversarial review conclusion: do NOT overload `work_status` (the kanban lane)
-- with a `closed` value — that pushes dropped conversations into the board's
-- To-do lane and gives `resolved_at` two meanings. Model the lifecycle
-- ORTHOGONALLY:
--   Open   = resolved_at IS NULL
--   Solved = resolution = 'solved'   (work done)
--   Closed = resolution = 'closed'   (dropped, no action)
-- Both Solved and Closed also stamp resolved_at (so the existing "open"
-- predicate, shared with the legacy Portal-Chats view, keeps working) and set
-- work_status='handled' so the kanban card lands in the Done lane. `resolution`
-- is the single source of truth for solved-vs-closed.

ALTER TABLE internal_threads
  ADD COLUMN IF NOT EXISTS resolution text,
  ADD COLUMN IF NOT EXISTS resolved_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'internal_threads_resolution_check'
  ) THEN
    ALTER TABLE internal_threads
      ADD CONSTRAINT internal_threads_resolution_check
      CHECK (resolution IS NULL OR resolution IN ('solved', 'closed'));
  END IF;
END $$;

-- Surface `resolution` in the sidebar payload so the header can render
-- Solved vs Closed (and the grouped list, S3, can filter by state). Return-type
-- change → must DROP then CREATE (CREATE OR REPLACE cannot alter the signature).
-- Definition copied verbatim from the live prod/sandbox function (identical on
-- both, verified 2026-07-10) with `resolution` added after `resolved_at`.
DROP FUNCTION IF EXISTS get_team_threads(uuid);

CREATE FUNCTION public.get_team_threads(p_user_id uuid)
 RETURNS TABLE(id uuid, thread_type text, title text, channel_name text, channel_slug text, description text, color text, account_id uuid, contact_id uuid, dm_key text, resolved_at timestamp with time zone, resolution text, archived_at timestamp with time zone, created_by uuid, created_at timestamp with time zone, last_activity_at timestamp with time zone, parent_channel_id uuid, work_status text, later boolean, unread_count bigint, mention_count bigint, label text, last_message text, last_message_at timestamp with time zone, last_sender_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    t.id, t.thread_type, t.title, t.channel_name, t.channel_slug,
    t.description, t.color, t.account_id, t.contact_id, t.dm_key,
    t.resolved_at, t.resolution, t.archived_at, t.created_by, t.created_at,
    t.last_activity_at, t.parent_channel_id, t.work_status,
    COALESCE(r.later, false) AS later,
    GREATEST(
      COALESCE((
        SELECT count(*) FROM internal_messages m
         WHERE m.thread_id = t.id
           AND m.deleted_at IS NULL
           AND m.sender_id <> p_user_id
           AND m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
      ), 0),
      CASE WHEN COALESCE(r.manual_unread, false) THEN 1 ELSE 0 END
    ) AS unread_count,
    COALESCE((
      SELECT count(*) FROM internal_messages m
       WHERE m.thread_id = t.id
         AND m.deleted_at IS NULL
         AND m.sender_id <> p_user_id
         AND p_user_id = ANY(m.mentioned_user_ids)
         AND m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
    ), 0) AS mention_count,
    CASE
      WHEN t.thread_type = 'general' THEN 'general'
      WHEN t.thread_type = 'channel' THEN COALESCE(t.channel_name, t.channel_slug, t.title)
      WHEN t.thread_type = 'discussion' THEN COALESCE(a.company_name, c.full_name, l.full_name, t.title, 'Discussion')
      ELSE COALESCE(t.title, 'Thread')
    END AS label,
    lm.message      AS last_message,
    lm.created_at   AS last_message_at,
    lm.sender_name  AS last_sender_name
  FROM internal_threads t
  LEFT JOIN internal_thread_reads r
    ON r.thread_id = t.id AND r.user_id = p_user_id
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN contacts c ON c.id = t.contact_id
  LEFT JOIN leads   l ON l.id = t.lead_id
  LEFT JOIN LATERAL (
    SELECT m.message, m.created_at, m.sender_name
      FROM internal_messages m
     WHERE m.thread_id = t.id AND m.deleted_at IS NULL
     ORDER BY m.created_at DESC
     LIMIT 1
  ) lm ON true
  WHERE t.archived_at IS NULL
    AND (
      t.thread_type <> 'dm'
      OR t.dm_key LIKE '%' || p_user_id::text || '%'
    )
  ORDER BY COALESCE(t.last_activity_at, t.created_at) DESC;
$function$;
