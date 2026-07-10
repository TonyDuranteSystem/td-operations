-- Team Workspace S3 — client-grouped conversation sidebar.
--
-- The grouped list needs a STABLE grouping key + the topic per row, computed
-- server-side (the review: never group on the display label string; a lead has
-- no grouping key today because get_team_threads doesn't project lead_id).
--
-- Adds to get_team_threads:
--   lead_id       — so lead-anchored conversations have a real key
--   topic         — so a child row can show "Billing" (the title is "Client · Billing")
--   client_key    — 'account:<id>' | 'contact:<id>' | 'lead:<id>' | 'internal'
--                   (discussions only; NULL for channels/dm/general)
--   client_label  — the group header name; 'Internal / No client' when unanchored
--
-- DELIBERATE DEFERRAL (named, per review): a contact-anchored conversation is
-- NOT merged under the contact's parent account — it groups on 'contact:<id>'.
-- Merging needs the account_contacts join and a rule for multi-account contacts;
-- for this 2-person shop, shares are filed on the account directly, so the split
-- is rare. Revisit if it bites. This keeps S3 shippable + reversible.
--
-- Return-type change → DROP then CREATE. Definition = the S2 function (verified
-- identical prod/sandbox) + the four new projected columns.

DROP FUNCTION IF EXISTS get_team_threads(uuid);

CREATE FUNCTION public.get_team_threads(p_user_id uuid)
 RETURNS TABLE(id uuid, thread_type text, title text, channel_name text, channel_slug text, description text, color text, account_id uuid, contact_id uuid, lead_id uuid, dm_key text, resolved_at timestamp with time zone, resolution text, archived_at timestamp with time zone, created_by uuid, created_at timestamp with time zone, last_activity_at timestamp with time zone, parent_channel_id uuid, work_status text, topic text, client_key text, client_label text, later boolean, unread_count bigint, mention_count bigint, label text, last_message text, last_message_at timestamp with time zone, last_sender_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    t.id, t.thread_type, t.title, t.channel_name, t.channel_slug,
    t.description, t.color, t.account_id, t.contact_id, t.lead_id, t.dm_key,
    t.resolved_at, t.resolution, t.archived_at, t.created_by, t.created_at,
    t.last_activity_at, t.parent_channel_id, t.work_status, t.topic,
    CASE
      WHEN t.thread_type <> 'discussion' THEN NULL
      WHEN t.account_id IS NOT NULL THEN 'account:' || t.account_id
      WHEN t.contact_id IS NOT NULL THEN 'contact:' || t.contact_id
      WHEN t.lead_id    IS NOT NULL THEN 'lead:'    || t.lead_id
      ELSE 'internal'
    END AS client_key,
    CASE
      WHEN t.thread_type <> 'discussion' THEN NULL
      ELSE COALESCE(a.company_name, c.full_name, l.full_name, 'Internal / No client')
    END AS client_label,
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
