-- Team Chat "on behalf of" identity for Claude-sent messages (dev job 8537adf9).
--
-- PROBLEM: messages posted through Claude (MCP team_chat_send / worker) carry
-- sender = the Claude sentinel, so every notification exclusion ("not the
-- sender") misses the HUMAN who dictated the message — Antonio gets pushed,
-- toasted, and badge-lit for his own words.
--
-- DESIGN (council-reviewed 2026-07-29): a nullable on_behalf_of_user_id column
-- stamped at the post-message choke-point. NO read pointers are written on the
-- acting user's behalf — three reviewers independently showed pointer writes
-- wipe unread state for messages the user never saw (and fake "seen by"
-- receipts). Instead every unread READER treats "dictated by me" as "mine".
--
-- Function bases: live prod defs pulled 2026-07-29 via pg_get_functiondef.
-- Drift check: sandbox bodies are IDENTICAL to prod after comment-strip
-- (sandbox stores comment-less defs); md5s recorded in the dev job.

ALTER TABLE internal_messages ADD COLUMN IF NOT EXISTS on_behalf_of_user_id uuid;

COMMENT ON COLUMN internal_messages.on_behalf_of_user_id IS
  'Staff auth-user who dictated this Claude-sent message (null = nobody / unknown → everyone is notified). Sender stays the Claude sentinel; this column only silences the dictating user''s notifications and unread.';

-- ── get_team_threads: unread_count + mention_count learn on-behalf ──────────
-- Base: live PROD definition (2026-07-29). Change: every `sender_id <> p_user_id`
-- exclusion also excludes rows the caller dictated (on_behalf_of_user_id = caller).

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
      t.thread_type <> 'dm'
      OR t.dm_key LIKE '%' || p_user_id::text || '%'
    )
  ORDER BY COALESCE(t.last_activity_at, t.created_at) DESC;
$function$;

-- ── list_followed_unread_threads: the menu dot learns on-behalf ─────────────
-- Base: live PROD definition (2026-07-29; identical on sandbox).

CREATE OR REPLACE FUNCTION public.list_followed_unread_threads(p_user_id uuid)
 RETURNS TABLE(root_message_id uuid, thread_id uuid, thread_label text, title text, unread_count integer, last_reply_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    f.root_message_id,
    root.thread_id,
    COALESCE(t.channel_slug, t.channel_name, 'general')                  AS thread_label,
    COALESCE(
      NULLIF(ts.title, ''),
      CASE WHEN root.deleted_at IS NOT NULL THEN 'Message deleted'
           ELSE COALESCE(NULLIF(root.message, ''), 'Attachment') END
    )                                                                    AS title,
    -- A hand-marked thread with no new replies still counts as one, so the
    -- dropdown row is never labelled "0".
    GREATEST(
      (SELECT COUNT(*)::int
         FROM public.internal_messages m
        WHERE m.root_id = f.root_message_id
          AND m.deleted_at IS NULL
          AND m.sender_id <> p_user_id
          AND (m.on_behalf_of_user_id IS NULL OR m.on_behalf_of_user_id <> p_user_id)
          AND m.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz)),
      CASE WHEN COALESCE(rr.manual_unread, false) THEN 1 ELSE 0 END
    )                                                                    AS unread_count,
    (SELECT MAX(m.created_at)
       FROM public.internal_messages m
      WHERE m.root_id = f.root_message_id
        AND m.deleted_at IS NULL
        AND m.sender_id <> p_user_id
        AND (m.on_behalf_of_user_id IS NULL OR m.on_behalf_of_user_id <> p_user_id)
        AND m.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz)) AS last_reply_at
  FROM public.internal_root_follows f
  JOIN public.internal_messages root ON root.id = f.root_message_id
  JOIN public.internal_threads  t    ON t.id = root.thread_id
                                    AND t.thread_type IN ('channel', 'general')
  LEFT JOIN public.internal_thread_state ts ON ts.root_message_id = f.root_message_id
  LEFT JOIN public.internal_root_reads  rr
         ON rr.root_message_id = f.root_message_id AND rr.user_id = p_user_id
  WHERE f.user_id = p_user_id
    AND ts.archived_at IS NULL
    AND (
      COALESCE(rr.manual_unread, false)
      OR EXISTS (
        SELECT 1
          FROM public.internal_messages m
         WHERE m.root_id = f.root_message_id
           AND m.deleted_at IS NULL
           AND m.sender_id <> p_user_id
           AND (m.on_behalf_of_user_id IS NULL OR m.on_behalf_of_user_id <> p_user_id)
           AND m.created_at > COALESCE(rr.last_read_at, '-infinity'::timestamptz)
      )
    );
$function$;

-- ── list_all_threads: the All-Threads board + notifications dropdown ────────
-- Found by the post-build verification pass: this THIRD unread reader kept the
-- bare sender check, so the All-Threads board and the sidebar dropdown showed
-- "New" (and pushed a dropdown row) for a message the caller themself dictated,
-- disagreeing with the two readers above. Base: live PROD definition
-- (2026-07-29, md5-identical on sandbox).

CREATE OR REPLACE FUNCTION public.list_all_threads(p_user_id uuid, p_limit integer DEFAULT 300, p_include_archived boolean DEFAULT false)
 RETURNS TABLE(root_message_id uuid, thread_id uuid, channel_label text, title text, status text, assignee_id uuid, reply_count integer, last_activity_at timestamp with time zone, unread boolean, following boolean, archived boolean, later boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH roots AS (
    SELECT
      m.id, m.thread_id, m.message, m.sender_id, m.on_behalf_of_user_id, m.created_at, m.deleted_at,
      t.channel_slug, t.channel_name,
      ts.status, ts.assignee_id, ts.title AS state_title, ts.created_as_thread, ts.archived_at,
      rr.last_read_at, COALESCE(rr.manual_unread, false) AS manual_unread
    FROM public.internal_messages m
    JOIN public.internal_threads t
      ON t.id = m.thread_id AND t.thread_type IN ('channel', 'general') AND t.archived_at IS NULL
    LEFT JOIN public.internal_thread_state ts ON ts.root_message_id = m.id
    LEFT JOIN public.internal_root_reads  rr ON rr.root_message_id = m.id AND rr.user_id = p_user_id
    WHERE m.root_id IS NULL
      AND (p_include_archived OR ts.archived_at IS NULL)
      AND (
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
    -- New for me: manually marked unread, an unseen root from someone else, or
    -- an unseen other-reply. A message the caller DICTATED via Claude counts as
    -- their own, never as new.
    (
      r.manual_unread
      OR (r.sender_id <> p_user_id AND r.deleted_at IS NULL
          AND (r.on_behalf_of_user_id IS NULL OR r.on_behalf_of_user_id <> p_user_id)
          AND r.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz))
      OR EXISTS (
        SELECT 1 FROM public.internal_messages c
         WHERE c.root_id = r.id AND c.deleted_at IS NULL
           AND c.sender_id <> p_user_id
           AND (c.on_behalf_of_user_id IS NULL OR c.on_behalf_of_user_id <> p_user_id)
           AND c.created_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
      )
    ),
    EXISTS (SELECT 1 FROM public.internal_root_follows f
             WHERE f.root_message_id = r.id AND f.user_id = p_user_id),
    (r.archived_at IS NOT NULL),
    EXISTS (SELECT 1 FROM public.internal_root_later l
             WHERE l.root_message_id = r.id AND l.user_id = p_user_id)
  FROM roots r
  ORDER BY 8 DESC
  LIMIT GREATEST(p_limit, 1);
$function$;
