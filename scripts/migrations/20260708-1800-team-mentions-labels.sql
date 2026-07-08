-- Team Workspace — Mentions inbox + sidebar scale fix (Luca's proposals, panel-revised).
-- 1. internal_messages.mentioned_user_ids uuid[] — resolved USER IDS stored at
--    send time (handles in `mentions` stay for display; ids make the pending-
--    mention badge queryable + unambiguous).
-- 2. get_team_threads returns per-caller mention_count ("pending mention" =
--    mentioned in a message newer than my last_read_at in that thread — reuses
--    the per-user read model, clears naturally on open) AND a server-computed
--    label (accounts/contacts/leads join) — kills the route's per-thread N+1
--    lookups that would degrade first as clients grow.
-- Additive; DROP+CREATE of the RPC is atomic in this txn. Safe on sandbox + prod.

BEGIN;

ALTER TABLE public.internal_messages
  ADD COLUMN IF NOT EXISTS mentioned_user_ids uuid[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_internal_messages_mentioned
  ON public.internal_messages USING gin (mentioned_user_ids)
  WHERE deleted_at IS NULL;

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
  mention_count     bigint,
  label             text,
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

COMMIT;
