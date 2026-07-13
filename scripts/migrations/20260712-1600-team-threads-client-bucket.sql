-- Phase 1 (Conversations buckets, dev_task be582c5e): add a server-computed
-- `client_bucket` + `lead_status` to get_team_threads so the Team Chat
-- Conversations sidebar can label each conversation (Active client / Suspended /
-- Cancelled / Off-boarded / Partner / Individual / Lead / Internal) and group
-- into top-level sections — WITHOUT an N+1 lookup on the client.
--
-- Bucket rule (first match wins, account precedence mirrors client_key):
--   non-discussion            -> NULL
--   partner-type company      -> 'partner'
--   company-anchored          -> by accounts.status (Active|Suspended|Cancelled|Closed/Offboarding)
--   partner person            -> 'partner'
--   person who owns company(s) -> best status across owned companies
--   person who owns none       -> 'individual'
--   lead-anchored             -> 'lead'
--   else                      -> 'internal'
-- Ownership = account_contacts (contact_id -> account_id) UNION contacts.primary_company_id.
-- "Off-boarded" = Closed OR Offboarding; "Cancelled" kept separate (Antonio 2026-07-12).
--
-- Signature change (adds 2 trailing columns) => DROP + CREATE. Based verbatim on
-- the live def (prod == sandbox, byte-identical pre-change) with ONLY the two new
-- columns + the ownership LATERAL added; everything else unchanged.

DROP FUNCTION IF EXISTS public.get_team_threads(uuid);

CREATE OR REPLACE FUNCTION public.get_team_threads(p_user_id uuid)
 RETURNS TABLE(id uuid, thread_type text, title text, channel_name text, channel_slug text, description text, color text, account_id uuid, contact_id uuid, lead_id uuid, dm_key text, resolved_at timestamp with time zone, resolution text, archived_at timestamp with time zone, created_by uuid, created_at timestamp with time zone, last_activity_at timestamp with time zone, parent_channel_id uuid, work_status text, topic text, client_key text, client_label text, is_participant boolean, later boolean, unread_count bigint, mention_count bigint, label text, last_message text, last_message_at timestamp with time zone, last_sender_name text, client_bucket text, lead_status text)
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
    (r.thread_id IS NOT NULL) AS is_participant,
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
    lm.sender_name  AS last_sender_name,
    CASE
      WHEN t.thread_type <> 'discussion' THEN NULL
      -- partner-type company wins
      WHEN a.account_type = 'Partner' THEN 'partner'
      -- company-anchored: label by the company lifecycle status
      WHEN t.account_id IS NOT NULL THEN
        CASE a.status::text
          WHEN 'Active'      THEN 'active_client'
          WHEN 'Suspended'   THEN 'suspended'
          WHEN 'Cancelled'   THEN 'cancelled'
          WHEN 'Closed'      THEN 'offboarded'
          WHEN 'Offboarding' THEN 'offboarded'
          ELSE 'active_client'
        END
      -- partner person wins
      WHEN c.is_partner IS TRUE THEN 'partner'
      -- person-anchored: owns company(s) -> best owned status; owns none -> individual
      WHEN t.contact_id IS NOT NULL THEN
        CASE
          WHEN own.owned_n > 0 THEN
            CASE
              WHEN own.has_active     THEN 'active_client'
              WHEN own.has_suspended  THEN 'suspended'
              WHEN own.has_cancelled  THEN 'cancelled'
              WHEN own.has_offboarded THEN 'offboarded'
              ELSE 'active_client'
            END
          ELSE 'individual'
        END
      WHEN t.lead_id IS NOT NULL THEN 'lead'
      ELSE 'internal'
    END AS client_bucket,
    CASE WHEN t.thread_type = 'discussion' THEN l.status ELSE NULL END AS lead_status
  FROM internal_threads t
  LEFT JOIN internal_thread_reads r
    ON r.thread_id = t.id AND r.user_id = p_user_id
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN contacts c ON c.id = t.contact_id
  LEFT JOIN leads   l ON l.id = t.lead_id
  LEFT JOIN LATERAL (
    SELECT
      count(*) AS owned_n,
      bool_or(oa.status = 'Active')                      AS has_active,
      bool_or(oa.status = 'Suspended')                   AS has_suspended,
      bool_or(oa.status = 'Cancelled')                   AS has_cancelled,
      bool_or(oa.status IN ('Closed', 'Offboarding'))    AS has_offboarded
    FROM accounts oa
    WHERE t.contact_id IS NOT NULL
      AND oa.id IN (
        SELECT ac.account_id FROM account_contacts ac WHERE ac.contact_id = t.contact_id
        UNION
        SELECT c.primary_company_id WHERE c.primary_company_id IS NOT NULL
      )
  ) own ON true
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
