-- Team Workspace — extend get_team_threads for the organizer layer:
-- return parent_channel_id, work_status, later; and let a manual "mark unread"
-- force the badge on (unread_count = max(computed, manual_unread?1:0)).
-- CREATE OR REPLACE — additive, safe on sandbox and prod.

BEGIN;

-- Return signature gains columns → must DROP before CREATE (atomic in this txn).
DROP FUNCTION IF EXISTS public.get_team_threads(uuid);

CREATE OR REPLACE FUNCTION public.get_team_threads(p_user_id uuid)
RETURNS TABLE (
  id                uuid,
  thread_type       text,
  title             text,
  channel_name      text,
  channel_slug      text,
  description       text,
  color             text,
  account_id        uuid,
  contact_id        uuid,
  dm_key            text,
  resolved_at       timestamptz,
  archived_at       timestamptz,
  created_by        uuid,
  created_at        timestamptz,
  last_activity_at  timestamptz,
  parent_channel_id uuid,
  work_status       text,
  later             boolean,
  unread_count      bigint,
  last_message      text,
  last_message_at   timestamptz,
  last_sender_name  text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    t.id, t.thread_type, t.title, t.channel_name, t.channel_slug,
    t.description, t.color, t.account_id, t.contact_id, t.dm_key,
    t.resolved_at, t.archived_at, t.created_by, t.created_at,
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
    lm.message      AS last_message,
    lm.created_at   AS last_message_at,
    lm.sender_name  AS last_sender_name
  FROM internal_threads t
  LEFT JOIN internal_thread_reads r
    ON r.thread_id = t.id AND r.user_id = p_user_id
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

COMMIT;
