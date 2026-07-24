-- Team Workspace — a CHANNEL's unread count becomes "how many bugs have
-- something new", counted per thread, and stops clearing when you open the
-- channel.
--
-- Antonio 2026-07-24, on td-bug: "When I have the red notification on the debug
-- channel and I open one, the red note disappears, so I don't have control."
-- He is right, and this is exactly why:
--
--   a channel's unread_count counted EVERY message in the channel — including
--   replies inside individual bug threads — against ONE pointer,
--   internal_thread_reads.last_read_at. Opening the channel advances that single
--   pointer (the GET marks read), so one glance at the stream marked as read
--   every reply in every bug he had never opened. The per-bug state survived
--   (internal_root_reads is a separate pointer, which is why the blue dot on
--   "3 replies" stayed) but nothing at channel grain reflected it.
--
-- After this, for thread_type = 'channel':
--   unread_count = the number of THREADS in that channel that are new for me.
-- Opening the channel cannot clear it — only opening each bug can, because the
-- count no longer reads the channel-level pointer at all.
--
-- ⚠️ THIS IS THE FOURTH READER OF "IS THIS THREAD NEW FOR ME". The other three
-- are computeThreadMeta (TS — panel + in-stream affordance), list_all_threads
-- (board) and list_followed_unread_threads (menu dot + dropdown). The
-- 20260718-1700 migration says it plainly: treat every unread reader as a
-- required update site, or the dot and the lists disagree. The predicate below
-- is copied from list_all_threads DELIBERATELY, character for character:
--   manual_unread, OR an unseen root from someone else, OR an unseen reply from
--   someone else.
--
-- WHICH ROOTS COUNT — the rule that makes the badge clearable. Only roots the
-- Threads panel actually LISTS are counted: a root with at least one reply, or
-- one carrying a state row that MEANS something (created on purpose, named,
-- archived, assigned, or triaged off 'todo'). That mirrors
-- threadStateIsMeaningful + the panel query in GET /api/team/threads/[id].
-- Counting anything the panel does not show would produce a badge with nothing
-- to click — a number that can never reach zero. Plain channel chatter
-- therefore does not raise the count; it still pushes and still pops up in the
-- CRM, it just is not a unit of work to be cleared.
-- NOTE this is deliberately STRICTER than list_all_threads' own WHERE clause,
-- which reads `ts.status IS DISTINCT FROM 'todo'` and so treats a root with NO
-- state row as meaningful (NULL IS DISTINCT FROM 'todo' is true). That makes
-- the board show plain messages as phantom threads — pre-existing, not fixed
-- here, and not copied here.
--
-- UNCHANGED: dm, discussion and the 'general' room keep the old whole-thread
-- count. General holds 48 top-level messages with zero replies and no per-root
-- read rows, so root-grain counting there would light a badge that nothing in
-- the UI could ever clear.
-- Also unchanged: mention_count, every other column, and the row filter.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_team_threads(p_user_id uuid)
RETURNS TABLE(
  id uuid, thread_type text, title text, channel_name text, channel_slug text,
  description text, color text, account_id uuid, contact_id uuid, lead_id uuid,
  dm_key text, resolved_at timestamp with time zone, resolution text,
  archived_at timestamp with time zone, created_by uuid,
  created_at timestamp with time zone, last_activity_at timestamp with time zone,
  parent_channel_id uuid, work_status text, topic text, client_key text,
  client_label text, is_participant boolean, later boolean, unread_count bigint,
  mention_count bigint, label text, last_message text,
  last_message_at timestamp with time zone, last_sender_name text,
  client_bucket text, lead_status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
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
             -- new for me (same three terms as list_all_threads)
             AND (
               COALESCE(rr.manual_unread, false)
               OR (root.sender_id <> p_user_id AND root.deleted_at IS NULL
                   AND root.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz))
               OR EXISTS (
                 SELECT 1 FROM internal_messages c
                  WHERE c.root_id = root.id AND c.deleted_at IS NULL
                    AND c.sender_id <> p_user_id
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
      t.thread_type <> 'dm'
      OR t.dm_key LIKE '%' || p_user_id::text || '%'
    )
  ORDER BY COALESCE(t.last_activity_at, t.created_at) DESC;
$function$;

-- Counting per root means one subquery per root per channel row. These two
-- indexes are what keep that cheap; both are the access patterns the count uses.
CREATE INDEX IF NOT EXISTS idx_internal_messages_thread_roots
  ON public.internal_messages (thread_id, created_at DESC)
  WHERE root_id IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_internal_messages_root_live
  ON public.internal_messages (root_id, created_at DESC)
  WHERE root_id IS NOT NULL AND deleted_at IS NULL;

COMMIT;
