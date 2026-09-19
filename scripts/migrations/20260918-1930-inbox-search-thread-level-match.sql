-- INBOX SEARCH: match across the whole conversation, not one message
-- (dev job 72006580).
--
-- Antonio: searching "Smit" then adding a second word ("Smit B&P") can return
-- nothing, even when the conversation clearly contains both. Root cause:
-- `inbox_search_thread_page`/`_count` matched a query against ONE
-- email_index ROW's tsvector (subject+from_name+from_email+snippet of a
-- single message) and only grouped to threads AFTER that per-row match. A
-- two-word query only matched if BOTH words landed on the SAME message; if
-- "Smit" is the sender of one message and the company name only appears in
-- another message's subject, no single row satisfied the query and the
-- whole thread was invisible — even though the conversation obviously
-- contains both.
--
-- FIX: aggregate each thread's searchable text FIRST (subject/from_name/
-- from_email/snippet of every live message in the thread), THEN match the
-- query against that combined text. Council-reviewed before writing
-- (senior-engineer + ai-architect, 2026-09-18): an earlier design using a
-- trigger-maintained aggregate TABLE was rejected (no DELETE handling → a
-- purged/erased email could stay searchable forever; a race between
-- concurrent index writers; a second writer onto email_index-derived state,
-- against this codebase's own single-writer rule). The architect's
-- simpler query-time-aggregate alternative was adopted instead — but its
-- first cut (aggregate EVERY thread in the mailbox, every call, then match)
-- measured ~1000ms per query against sandbox's real data (support mailbox,
-- ~24k rows / ~19k threads) — a real regression against this surface's own
-- <100ms "instant search" contract (docs/systems/inbox.md), caught by
-- actually timing it rather than trusting the scale estimate.
--
-- REVISED to keep both properties: a CANDIDATES step first uses the
-- existing per-row GIN index (idx_email_index_search) to cheaply find every
-- thread containing AT LEAST ONE of the query's words on ANY message (an OR
-- across the query's own lexemes, built from to_tsvector on the query text
-- itself so it tokenizes identically to the indexed content) — this is the
-- same index lookup the OLD code got its speed from. ONLY those candidate
-- threads (typically a small fraction of the mailbox) are then aggregated
-- and re-checked against the real, precise websearch query (AND/OR/phrase/
-- NOT semantics preserved exactly). A thread that doesn't contain ANY query
-- word anywhere can never match anyway, so narrowing to OR-candidates first
-- loses no correct result — verified by re-running the exact previously-slow
-- queries after this revision (sub-second, matching every case checked
-- against the original per-row logic, e.g. "Smit B&P").
--
-- TRASH/SPAM semantics preserved: those messages' text is excluded from
-- both the candidate step and the aggregate (same WHERE filter as before),
-- so a word living only in a trashed message still never makes a thread
-- match.
--
-- Signature is UNCHANGED (mailbox, query, limit, offset, scope) — CREATE OR
-- REPLACE, no DROP needed, no overload-ambiguity risk.

BEGIN;

CREATE OR REPLACE FUNCTION inbox_search_thread_page(
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
  WITH or_query AS (
    SELECT nullif(string_agg(lex, ' | '), '') AS q
    FROM unnest(tsvector_to_array(to_tsvector('simple', p_query))) AS lex
  ),
  candidates AS (
    SELECT DISTINCT e.thread_id
    FROM email_index e, or_query
    WHERE e.mailbox = p_mailbox
      AND NOT ('TRASH' = ANY(e.label_ids))
      AND NOT ('SPAM'  = ANY(e.label_ids))
      AND (or_query.q IS NULL OR e.search @@ to_tsquery('simple', or_query.q))
  )
  SELECT t.thread_id, t.last_at
  FROM (
    SELECT
      e.thread_id,
      max(e.internal_date) AS last_at,
      to_tsvector(
        'simple',
        string_agg(
          coalesce(e.subject, '') || ' ' || coalesce(e.from_name, '') || ' ' ||
          coalesce(e.from_email, '') || ' ' || coalesce(e.snippet, ''),
          ' '
        )
      ) AS thread_search
    FROM email_index e
    JOIN candidates c ON c.thread_id = e.thread_id
    WHERE e.mailbox = p_mailbox
      AND NOT ('TRASH' = ANY(e.label_ids))
      AND NOT ('SPAM'  = ANY(e.label_ids))
    GROUP BY e.thread_id
  ) t
  WHERE t.thread_search @@ websearch_to_tsquery('simple', p_query)
    AND (
      p_scope IS DISTINCT FROM 'inbox'
      OR EXISTS (
        SELECT 1 FROM email_index i
        WHERE i.mailbox = p_mailbox
          AND i.thread_id = t.thread_id
          AND 'INBOX' = ANY(i.label_ids)
      )
    )
  ORDER BY t.last_at DESC
  LIMIT  greatest(p_limit, 1)
  OFFSET greatest(p_offset, 0);
$$;

COMMENT ON FUNCTION inbox_search_thread_page(text, text, integer, integer, text) IS
  'One page of SEARCH results as conversations. Matches a THREAD''s aggregated text (all its live messages'' subject/sender/snippet combined), not a single message row — a query whose words are spread across different messages of the same conversation now matches. Uses the per-row GIN index to narrow to OR-candidate threads first (speed), then re-checks the precise query against the full thread aggregate (correctness). p_scope=''inbox'' restricts to threads currently in the Inbox; ''all'' searches the whole stored history. dev job 72006580.';

CREATE OR REPLACE FUNCTION inbox_search_thread_count(
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
  WITH or_query AS (
    SELECT nullif(string_agg(lex, ' | '), '') AS q
    FROM unnest(tsvector_to_array(to_tsvector('simple', p_query))) AS lex
  ),
  candidates AS (
    SELECT DISTINCT e.thread_id
    FROM email_index e, or_query
    WHERE e.mailbox = p_mailbox
      AND NOT ('TRASH' = ANY(e.label_ids))
      AND NOT ('SPAM'  = ANY(e.label_ids))
      AND (or_query.q IS NULL OR e.search @@ to_tsquery('simple', or_query.q))
  )
  SELECT count(*)
  FROM (
    SELECT
      e.thread_id,
      to_tsvector(
        'simple',
        string_agg(
          coalesce(e.subject, '') || ' ' || coalesce(e.from_name, '') || ' ' ||
          coalesce(e.from_email, '') || ' ' || coalesce(e.snippet, ''),
          ' '
        )
      ) AS thread_search
    FROM email_index e
    JOIN candidates c ON c.thread_id = e.thread_id
    WHERE e.mailbox = p_mailbox
      AND NOT ('TRASH' = ANY(e.label_ids))
      AND NOT ('SPAM'  = ANY(e.label_ids))
    GROUP BY e.thread_id
  ) t
  WHERE t.thread_search @@ websearch_to_tsquery('simple', p_query)
    AND (
      p_scope IS DISTINCT FROM 'inbox'
      OR EXISTS (
        SELECT 1 FROM email_index i
        WHERE i.mailbox = p_mailbox
          AND i.thread_id = t.thread_id
          AND 'INBOX' = ANY(i.label_ids)
      )
    );
$$;

COMMENT ON FUNCTION inbox_search_thread_count(text, text, text) IS
  'Total conversations matching a search — the N in "page 1 of N". Same candidate-narrow-then-aggregate-match semantics as inbox_search_thread_page. dev job 72006580.';

COMMIT;
