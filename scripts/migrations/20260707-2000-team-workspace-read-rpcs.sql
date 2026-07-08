-- Team Workspace — Phase 1 read-side RPCs
-- Single-call, per-user thread list with correct unread counts + a search fn.
-- Additive (CREATE OR REPLACE FUNCTION only). Safe on sandbox and prod.
--
-- Why RPCs: computing unread per thread from internal_thread_reads is a
-- per-thread, per-user comparison (created_at > last_read_at). Doing it in the
-- route would be an N+1. One set-returning function is correct and fast.

BEGIN;

-- ---------------------------------------------------------------------------
-- get_team_threads(p_user_id): every thread the user can see, with unread +
-- last-message preview. DMs are filtered to those the user participates in
-- (dm_key contains their id); channels/general/discussions are visible to all
-- staff.
-- ---------------------------------------------------------------------------
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
    t.last_activity_at,
    COALESCE((
      SELECT count(*) FROM internal_messages m
       WHERE m.thread_id = t.id
         AND m.deleted_at IS NULL
         AND m.sender_id <> p_user_id
         AND m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
    ), 0) AS unread_count,
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

-- ---------------------------------------------------------------------------
-- search_team_messages(p_user_id, p_query): full-text-ish ILIKE search across
-- messages the user can see (same DM visibility rule). Capped at 50.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_team_messages(p_user_id uuid, p_query text)
RETURNS TABLE (
  id            uuid,
  thread_id     uuid,
  thread_label  text,
  thread_type   text,
  sender_name   text,
  message       text,
  created_at    timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    m.id, m.thread_id,
    COALESCE(t.channel_name, t.title, 'Discussion') AS thread_label,
    t.thread_type, m.sender_name, m.message, m.created_at
  FROM internal_messages m
  JOIN internal_threads t ON t.id = m.thread_id
  WHERE m.deleted_at IS NULL
    AND p_query <> ''
    AND m.message ILIKE '%' || p_query || '%'
    AND (
      t.thread_type <> 'dm'
      OR t.dm_key LIKE '%' || p_user_id::text || '%'
    )
  ORDER BY m.created_at DESC
  LIMIT 50;
$function$;

COMMIT;
