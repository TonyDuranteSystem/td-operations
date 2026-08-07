-- INBOX: search scope (inbox-only default) + Archived view (dev job 21844d01).
--
-- Antonio, 2026-08-07: "when I search an email I want to search in inbox and
-- if I want to include the archive I want to have the option" — he archives
-- noise FROM search results, so an inbox-scoped search makes archived rows
-- genuinely leave the list. The Archived view gives archived mail a browsable
-- home for the first time (it previously existed in NO view — the root of
-- "the archive button is not working").
--
-- Council constraints baked in (5-seat review, 2026-08-07):
--  * Archived is judged at THREAD level (bool_or), never per message — labels
--    are per-message, and every replied-to thread has sent rows without INBOX;
--    a row-level NOT would list nearly the whole mailbox (senior engineer).
--  * SNOOZED threads are NOT archived — snooze also strips INBOX; they are
--    deliberately hidden and scheduled to return (3 seats independently).
--    Guarded twice: the caller passes the mailbox's snooze/user labels to
--    exclude, AND any thread with a live email_snoozes row is excluded.
--  * Pure-SENT and pure-DRAFT threads are excluded; a thread with received
--    mail plus a draft reply still shows (drafts excluded as ROWS, not threads).
--  * The search functions change SIGNATURE (new p_scope): the old 4-arg
--    versions are DROPPED in the same transaction — leaving them would create
--    an overload PostgREST cannot disambiguate, erroring EVERY search
--    (bug-hunter). p_scope defaults to 'all' so pre-deploy code keeps today's
--    behavior; DDL must be applied BEFORE the code deploy in each environment.
--
-- Verified before writing: the live prod/sandbox definitions of the replaced
-- functions differ from each other and from the repo file by WHITESPACE ONLY
-- (pg_get_functiondef diffed on both, 2026-08-07) — nothing live is lost.

BEGIN;

-- ── Search: inbox-scoped by default, all-mail on request ────────────────────
DROP FUNCTION IF EXISTS inbox_search_thread_page(text, text, integer, integer);
DROP FUNCTION IF EXISTS inbox_search_thread_count(text, text);

CREATE FUNCTION inbox_search_thread_page(
  p_mailbox text,
  p_query   text,
  p_limit   integer,
  p_offset  integer,
  p_scope   text DEFAULT 'all'
)
RETURNS TABLE (thread_id text, last_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT e.thread_id, max(e.internal_date) AS last_at
  FROM email_index e
  WHERE e.mailbox = p_mailbox
    AND e.search @@ websearch_to_tsquery('simple', p_query)
    AND NOT ('TRASH' = ANY(e.label_ids))
    AND NOT ('SPAM'  = ANY(e.label_ids))
    -- Inbox scope is a property of the THREAD, not of the matching message:
    -- a thread sitting in the Inbox must match even when the message that
    -- matched the query is an old sent reply carrying no INBOX label.
    AND (
      p_scope IS DISTINCT FROM 'inbox'
      OR EXISTS (
        SELECT 1 FROM email_index i
        WHERE i.mailbox = e.mailbox
          AND i.thread_id = e.thread_id
          AND 'INBOX' = ANY(i.label_ids)
      )
    )
  GROUP BY e.thread_id
  ORDER BY max(e.internal_date) DESC
  LIMIT  greatest(p_limit, 1)
  OFFSET greatest(p_offset, 0);
$$;

COMMENT ON FUNCTION inbox_search_thread_page(text, text, integer, integer, text) IS
  'One page of SEARCH results as conversations. p_scope=''inbox'' restricts to threads currently in the Inbox (default view); ''all'' searches the whole stored history. dev job 21844d01.';

CREATE FUNCTION inbox_search_thread_count(
  p_mailbox text,
  p_query   text,
  p_scope   text DEFAULT 'all'
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT count(DISTINCT e.thread_id)
  FROM email_index e
  WHERE e.mailbox = p_mailbox
    AND e.search @@ websearch_to_tsquery('simple', p_query)
    AND NOT ('TRASH' = ANY(e.label_ids))
    AND NOT ('SPAM'  = ANY(e.label_ids))
    AND (
      p_scope IS DISTINCT FROM 'inbox'
      OR EXISTS (
        SELECT 1 FROM email_index i
        WHERE i.mailbox = e.mailbox
          AND i.thread_id = e.thread_id
          AND 'INBOX' = ANY(i.label_ids)
      )
    );
$$;

COMMENT ON FUNCTION inbox_search_thread_count(text, text, text) IS
  'How many conversations match a search in the given scope — the N in "page 1 of N", and the "N matches in all mail" bridge when an inbox-scoped search finds 0. dev job 21844d01.';

-- ── Archived view: everything filed away, thread-level ──────────────────────
CREATE FUNCTION inbox_archived_thread_page(
  p_mailbox        text,
  p_limit          integer,
  p_offset         integer,
  p_exclude_labels text[] DEFAULT '{}'
)
RETURNS TABLE (thread_id text, last_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT e.thread_id, max(e.internal_date) AS last_at
  FROM email_index e
  WHERE e.mailbox = p_mailbox
    AND NOT EXISTS (
      SELECT 1 FROM email_snoozes s
      WHERE s.mailbox = e.mailbox AND s.thread_id = e.thread_id
    )
  GROUP BY e.thread_id
  HAVING NOT bool_or('INBOX' = ANY(e.label_ids))
     AND NOT bool_or('TRASH' = ANY(e.label_ids))
     AND NOT bool_or('SPAM'  = ANY(e.label_ids))
     AND NOT bool_or(e.label_ids && p_exclude_labels)
     -- At least one RECEIVED message: excludes pure-SENT threads (sent mail
     -- never carries INBOX — without this the view IS the sent history) and
     -- pure-DRAFT threads, while a received thread with a draft reply stays.
     AND bool_or(NOT ('SENT' = ANY(e.label_ids)) AND NOT ('DRAFT' = ANY(e.label_ids)))
  ORDER BY max(e.internal_date) DESC
  LIMIT  greatest(p_limit, 1)
  OFFSET greatest(p_offset, 0);
$$;

COMMENT ON FUNCTION inbox_archived_thread_page(text, integer, integer, text[]) IS
  'One page of ARCHIVED conversations: out of the Inbox, not trashed/spam/snoozed, not pure-sent/pure-draft. Thread-level judgment (bool_or). Index-only — this view has NO live-Gmail fallback. dev job 21844d01.';

CREATE FUNCTION inbox_archived_thread_count(
  p_mailbox        text,
  p_exclude_labels text[] DEFAULT '{}'
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT count(*) FROM (
    SELECT e.thread_id
    FROM email_index e
    WHERE e.mailbox = p_mailbox
      AND NOT EXISTS (
        SELECT 1 FROM email_snoozes s
        WHERE s.mailbox = e.mailbox AND s.thread_id = e.thread_id
      )
    GROUP BY e.thread_id
    HAVING NOT bool_or('INBOX' = ANY(e.label_ids))
       AND NOT bool_or('TRASH' = ANY(e.label_ids))
       AND NOT bool_or('SPAM'  = ANY(e.label_ids))
       AND NOT bool_or(e.label_ids && p_exclude_labels)
       AND bool_or(NOT ('SENT' = ANY(e.label_ids)) AND NOT ('DRAFT' = ANY(e.label_ids)))
  ) t;
$$;

COMMENT ON FUNCTION inbox_archived_thread_count(text, text[]) IS
  'How many archived conversations exist — the N in "page 1 of N" for the Archived view. dev job 21844d01.';

COMMIT;
