-- Team GROUP chats (dev job c1e326dd — TD Talk groups; Antonio 2026-10-09: "add the option to create a group
-- between members of the team, for example: me, Luca and Jodi").
--
-- A group is an internal_threads row of the NEW type 'group' with an explicit member list. It is PRIVATE to its members:
-- get_team_threads and search_team_messages now return a group only to a member, exactly as they already do for a
-- direct message (dm_key). The thread read / send routes add the same membership check in code.
--
-- Changes (all additive except widening ONE existing CHECK and replacing two functions with a one-clause change):
--   1. internal_threads_thread_type_chk now also allows 'group'.
--   2. NEW table internal_thread_members (thread_id, user_id, added_by, added_at) + staff-only RLS + realtime.
--   3. get_team_threads / search_team_messages: the visibility WHERE gets the group clause. Their live definitions were
--      identical on production and sandbox (md5 57ce7c62… and 2b537836…) when this was written; ONLY that clause differs.
--
-- DDL must run BEFORE the code deploys (the code reads/writes the table and the new type).
-- Production: Antonio runs this in the Supabase SQL editor. After it runs, db/constraints.prod.json must be refreshed
-- for internal_threads_thread_type_chk (see docs/systems/talk.md).

BEGIN;

ALTER TABLE public.internal_threads DROP CONSTRAINT IF EXISTS internal_threads_thread_type_chk;
ALTER TABLE public.internal_threads
  ADD CONSTRAINT internal_threads_thread_type_chk
  CHECK ((thread_type = ANY (ARRAY['general'::text, 'channel'::text, 'discussion'::text, 'dm'::text, 'group'::text])));

CREATE TABLE IF NOT EXISTS public.internal_thread_members (
  thread_id uuid NOT NULL REFERENCES public.internal_threads(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL,
  added_by  uuid,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_internal_thread_members_user
  ON public.internal_thread_members (user_id);

-- Same staff-only RLS as the sibling internal_* tables (harmless where RLS is off).
ALTER TABLE public.internal_thread_members ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'internal_thread_members'
       AND policyname = 'internal_thread_members_staff_all'
  ) THEN
    CREATE POLICY internal_thread_members_staff_all
      ON public.internal_thread_members
      FOR ALL
      USING (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client')
      WITH CHECK (COALESCE(((auth.jwt() -> 'app_metadata') ->> 'role'), '') <> 'client');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
       AND tablename = 'internal_thread_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.internal_thread_members;
  END IF;
END $$;

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
    CASE
      -- ── CHANNELS: count BUGS WITH SOMETHING NEW, at thread grain ──────────
      WHEN t.thread_type = 'channel' THEN GREATEST(
        COALESCE((
          SELECT count(*)
            FROM internal_messages root
            LEFT JOIN internal_thread_state ts ON ts.root_message_id = root.id
            LEFT JOIN internal_root_reads  rr  ON rr.root_message_id = root.id
                                              AND rr.user_id = p_user_id
           WHERE root.thread_id = t.id
             AND root.root_id IS NULL
             AND ts.archived_at IS NULL
             -- listed by the Threads panel = clearable by a click there
             AND (
               ts.created_as_thread IS TRUE
               OR NULLIF(ts.title, '') IS NOT NULL
               OR ts.assignee_id IS NOT NULL
               OR (ts.status IS NOT NULL AND ts.status <> 'todo')
               OR EXISTS (SELECT 1 FROM internal_messages c
                           WHERE c.root_id = root.id AND c.deleted_at IS NULL)
             )
             -- new for me (same three terms as list_all_threads); a message the
             -- caller DICTATED via Claude counts as their own, never as new.
             AND (
               COALESCE(rr.manual_unread, false)
               OR (root.sender_id <> p_user_id AND root.deleted_at IS NULL
                   AND (root.on_behalf_of_user_id IS NULL OR root.on_behalf_of_user_id <> p_user_id)
                   AND root.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz))
               OR EXISTS (
                 SELECT 1 FROM internal_messages c
                  WHERE c.root_id = root.id AND c.deleted_at IS NULL
                    AND c.sender_id <> p_user_id
                    AND (c.on_behalf_of_user_id IS NULL OR c.on_behalf_of_user_id <> p_user_id)
                    AND c.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz)
               )
             )
        ), 0),
        -- "Mark channel unread" from the sidebar kebab still forces the badge on.
        CASE WHEN COALESCE(r.manual_unread, false) THEN 1 ELSE 0 END
      )
      -- ── DM / discussion / general: unchanged whole-thread count ───────────
      ELSE GREATEST(
        COALESCE((
          SELECT count(*) FROM internal_messages m
           WHERE m.thread_id = t.id
             AND m.deleted_at IS NULL
             AND m.sender_id <> p_user_id
             AND (m.on_behalf_of_user_id IS NULL OR m.on_behalf_of_user_id <> p_user_id)
             AND m.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
        ), 0),
        CASE WHEN COALESCE(r.manual_unread, false) THEN 1 ELSE 0 END
      )
    END AS unread_count,
    COALESCE((
      SELECT count(*) FROM internal_messages m
       WHERE m.thread_id = t.id
         AND m.deleted_at IS NULL
         AND m.sender_id <> p_user_id
         AND (m.on_behalf_of_user_id IS NULL OR m.on_behalf_of_user_id <> p_user_id)
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
      WHEN a.account_type = 'Partner' THEN 'partner'
      WHEN t.account_id IS NOT NULL THEN
        CASE a.status::text
          WHEN 'Active'      THEN 'active_client'
          WHEN 'Suspended'   THEN 'suspended'
          WHEN 'Cancelled'   THEN 'cancelled'
          WHEN 'Closed'      THEN 'offboarded'
          WHEN 'Offboarding' THEN 'offboarded'
          ELSE 'active_client'
        END
      WHEN c.is_partner IS TRUE THEN 'partner'
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
      t.thread_type NOT IN ('dm', 'group')
      OR (t.thread_type = 'dm' AND t.dm_key LIKE '%' || p_user_id::text || '%')
      -- a GROUP is private to its members (dev job c1e326dd, TD Talk groups)
      OR (t.thread_type = 'group' AND EXISTS (
            SELECT 1 FROM internal_thread_members gm
             WHERE gm.thread_id = t.id AND gm.user_id = p_user_id))
    )
  ORDER BY COALESCE(t.last_activity_at, t.created_at) DESC;
$function$;

CREATE OR REPLACE FUNCTION public.search_team_messages(p_user_id uuid, p_query text)
 RETURNS TABLE(id uuid, thread_id uuid, thread_label text, thread_type text, sender_name text, message text, created_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
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
      t.thread_type NOT IN ('dm', 'group')
      OR (t.thread_type = 'dm' AND t.dm_key LIKE '%' || p_user_id::text || '%')
      OR (t.thread_type = 'group' AND EXISTS (
            SELECT 1 FROM internal_thread_members gm
             WHERE gm.thread_id = t.id AND gm.user_id = p_user_id))
    )
  ORDER BY m.created_at DESC
  LIMIT 50;
$function$;

COMMIT;
