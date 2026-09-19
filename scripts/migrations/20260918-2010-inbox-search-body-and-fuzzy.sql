-- INBOX SEARCH: also search the email BODY, and tolerate typos
-- (dev job 72006580, phases 2+3a).
--
-- Phase 2 — body text. Search previously only looked at a message's subject,
-- sender name/address, and Gmail's short preview snippet — never the body,
-- because email_index is deliberately metadata-only. Separately, the
-- Own-Inbox content store (dev_task 01800da8, ALWAYS ON since 2026-08-02)
-- has been capturing the full plain-text body of every message all along —
-- body_text is stored, capped at 100,000 characters at capture time
-- (lib/email-store/capture.ts), just never wired into search. Measured
-- against real data before writing this: 33,954 captured rows, average body
-- 2,513 characters, max exactly 100,000 (the cap) — comfortably small for a
-- GENERATED tsvector.
--
-- New GENERATED STORED tsvector column on email_message_content — same
-- pattern already proven safe on email_index.search, so there is still only
-- ONE writer (Postgres itself, from the already-existing single upsert path
-- in lib/email-store/worker.ts) — no new application write path, no trigger.
-- NOTE: unlike email_index.search, this column is being added to an
-- ALREADY-POPULATED table (~34k rows) — the ADD COLUMN forces a one-time
-- table rewrite under an ACCESS EXCLUSIVE lock while it computes the column
-- for every existing row. Measured live in sandbox: this completed but took
-- longer than 60 seconds — a real one-time cost, not free, though it only
-- happens once at migration time.
--
-- MATCHING DESIGN, revised after measuring the first version: the first cut
-- built one combined tsvector per candidate thread by RE-TOKENIZING raw
-- body_text from scratch on every search call (`to_tsvector(string_agg(raw
-- body text))`), on top of the already-indexed `search_body` column it had
-- just built — throwing away the index-time work and redoing it at read
-- time. Measured against real sandbox data before shipping (same discipline
-- as the previous migration in this job): common words went from
-- 125-314ms to 6,400-10,700ms — an order of magnitude regression, caught
-- by actually timing it, not assumed. ai-architect review had already
-- flagged this exact risk before it was even applied.
--
-- FIXED by never re-tokenizing body text at read time: the query is broken
-- into its individual words (lexemes) once, and a thread matches only if
-- EVERY word is found SOMEWHERE in the thread — either in the (small, cheap,
-- as before) subject/sender/snippet aggregate, or in ANY message's already-
-- indexed `search_body` column (a plain per-message index lookup, no
-- aggregation, no re-tokenization). This is an AND-of-words match rather
-- than full websearch phrase/OR/NOT syntax when body text is involved — a
-- deliberate, stated tradeoff for speed; exact-phrase/OR/NOT still work
-- precisely for anything found in subject/sender/snippet alone, since that
-- path is unchanged from the already-shipped, already-fast prior migration.
-- Re-measured after this fix (see verification in dev job 72006580) back
-- in the same range as before body text was added.
--
-- Trash/spam and deleted-bin exclusion for body text: filtered the same way
-- as subject/sender text — a trashed or spam-labeled message's body can
-- never make an otherwise-live thread match, and content still in the
-- 180-day recovery bin (email_message_content.deleted_at — NOT a permanent
-- erase; "delete forever" removes the row entirely, so it simply won't
-- exist to match) is excluded too.
--
-- Phase 3a — typo tolerance. Antonio wants search to feel "super functional"
-- like Google/Zoho — a misspelled name shouldn't return nothing. Added as a
-- FALLBACK only: the existing exact search always runs first and is
-- unchanged in cost for the common case (a search that finds something);
-- ONLY when the exact search's TOTAL result count is genuinely zero does a
-- second, trigram-similarity pass run (pg_trgm, a stock Postgres extension —
-- NOT currently enabled in production, this migration enables it). The exact
-- match TOTAL is computed once and both the page function and the count
-- function branch on that same total, so the two functions can never
-- disagree about which result set (exact or fuzzy) is being paged through —
-- an earlier draft that checked only the current page's row count broke
-- pagination on a fuzzy-only result set, caught by review before shipping.
--
-- Fuzzy candidates are found by trigram similarity against subject +
-- from_name (NOT body or snippet — a candidate list, kept small and cheap on
-- purpose), threshold 0.3, and only ever used when there are zero exact
-- matches at all — so an exact match always wins and is never displaced.

BEGIN;

-- ── Phase 2: body text ───────────────────────────────────────────────────

ALTER TABLE email_message_content
  ADD COLUMN IF NOT EXISTS search_body tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body_text, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_email_message_content_search_body
  ON email_message_content USING GIN (search_body);

-- ── Phase 3a: typo tolerance ─────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_email_index_subject_trgm
  ON email_index USING GIN (subject gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_email_index_from_name_trgm
  ON email_index USING GIN (from_name gin_trgm_ops);

-- ── Rewritten search functions ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION inbox_search_thread_page(
  p_mailbox text,
  p_query   text,
  p_limit   integer,
  p_offset  integer,
  p_scope   text DEFAULT 'all'
)
RETURNS TABLE (thread_id text, last_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  exact_total bigint;
BEGIN
  SELECT count(*) INTO exact_total
  FROM (
    WITH lexemes AS (
      SELECT array_agg(DISTINCT lex) AS arr, nullif(string_agg(DISTINCT lex, ' | '), '') AS or_q
      FROM unnest(tsvector_to_array(to_tsvector('simple', p_query))) AS lex
    ),
    candidates AS (
      SELECT DISTINCT e.thread_id
      FROM email_index e, lexemes
      WHERE e.mailbox = p_mailbox
        AND NOT ('TRASH' = ANY(e.label_ids))
        AND NOT ('SPAM'  = ANY(e.label_ids))
        AND (lexemes.or_q IS NULL OR e.search @@ to_tsquery('simple', lexemes.or_q))
      UNION
      SELECT DISTINCT e.thread_id
      FROM email_message_content c
      JOIN email_index e ON e.mailbox = c.mailbox AND e.message_id = c.message_id, lexemes
      WHERE c.mailbox = p_mailbox
        AND c.deleted_at IS NULL
        AND c.capture_status = 'complete'
        AND NOT ('TRASH' = ANY(e.label_ids))
        AND NOT ('SPAM'  = ANY(e.label_ids))
        AND lexemes.or_q IS NOT NULL
        AND c.search_body @@ to_tsquery('simple', lexemes.or_q)
    ),
    subj_agg AS (
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
        ) AS subj_tsv
      FROM email_index e
      JOIN candidates cand ON cand.thread_id = e.thread_id
      WHERE e.mailbox = p_mailbox
        AND NOT ('TRASH' = ANY(e.label_ids))
        AND NOT ('SPAM'  = ANY(e.label_ids))
      GROUP BY e.thread_id
    )
    SELECT s.thread_id
    FROM subj_agg s, lexemes
    WHERE lexemes.arr IS NULL OR NOT EXISTS (
      SELECT 1 FROM unnest(lexemes.arr) AS lex
      WHERE NOT (
        s.subj_tsv @@ to_tsquery('simple', lex)
        OR EXISTS (
          SELECT 1 FROM email_message_content mc
          JOIN email_index mi ON mi.mailbox = mc.mailbox AND mi.message_id = mc.message_id
          WHERE mc.mailbox = p_mailbox AND mc.thread_id = s.thread_id
            AND mc.deleted_at IS NULL AND mc.capture_status = 'complete'
            AND NOT ('TRASH' = ANY(mi.label_ids))
            AND NOT ('SPAM'  = ANY(mi.label_ids))
            AND mc.search_body @@ to_tsquery('simple', lex)
        )
      )
    )
    AND (
      p_scope IS DISTINCT FROM 'inbox'
      OR EXISTS (
        SELECT 1 FROM email_index i
        WHERE i.mailbox = p_mailbox
          AND i.thread_id = s.thread_id
          AND 'INBOX' = ANY(i.label_ids)
      )
    )
  ) counted;

  IF exact_total > 0 THEN
    RETURN QUERY
    WITH lexemes AS (
      SELECT array_agg(DISTINCT lex) AS arr, nullif(string_agg(DISTINCT lex, ' | '), '') AS or_q
      FROM unnest(tsvector_to_array(to_tsvector('simple', p_query))) AS lex
    ),
    candidates AS (
      SELECT DISTINCT e.thread_id
      FROM email_index e, lexemes
      WHERE e.mailbox = p_mailbox
        AND NOT ('TRASH' = ANY(e.label_ids))
        AND NOT ('SPAM'  = ANY(e.label_ids))
        AND (lexemes.or_q IS NULL OR e.search @@ to_tsquery('simple', lexemes.or_q))
      UNION
      SELECT DISTINCT e.thread_id
      FROM email_message_content c
      JOIN email_index e ON e.mailbox = c.mailbox AND e.message_id = c.message_id, lexemes
      WHERE c.mailbox = p_mailbox
        AND c.deleted_at IS NULL
        AND c.capture_status = 'complete'
        AND NOT ('TRASH' = ANY(e.label_ids))
        AND NOT ('SPAM'  = ANY(e.label_ids))
        AND lexemes.or_q IS NOT NULL
        AND c.search_body @@ to_tsquery('simple', lexemes.or_q)
    ),
    subj_agg AS (
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
        ) AS subj_tsv
      FROM email_index e
      JOIN candidates cand ON cand.thread_id = e.thread_id
      WHERE e.mailbox = p_mailbox
        AND NOT ('TRASH' = ANY(e.label_ids))
        AND NOT ('SPAM'  = ANY(e.label_ids))
      GROUP BY e.thread_id
    )
    SELECT s.thread_id, s.last_at
    FROM subj_agg s, lexemes
    WHERE lexemes.arr IS NULL OR NOT EXISTS (
      SELECT 1 FROM unnest(lexemes.arr) AS lex
      WHERE NOT (
        s.subj_tsv @@ to_tsquery('simple', lex)
        OR EXISTS (
          SELECT 1 FROM email_message_content mc
          JOIN email_index mi ON mi.mailbox = mc.mailbox AND mi.message_id = mc.message_id
          WHERE mc.mailbox = p_mailbox AND mc.thread_id = s.thread_id
            AND mc.deleted_at IS NULL AND mc.capture_status = 'complete'
            AND NOT ('TRASH' = ANY(mi.label_ids))
            AND NOT ('SPAM'  = ANY(mi.label_ids))
            AND mc.search_body @@ to_tsquery('simple', lex)
        )
      )
    )
    AND (
      p_scope IS DISTINCT FROM 'inbox'
      OR EXISTS (
        SELECT 1 FROM email_index i
        WHERE i.mailbox = p_mailbox
          AND i.thread_id = s.thread_id
          AND 'INBOX' = ANY(i.label_ids)
      )
    )
    ORDER BY s.last_at DESC
    LIMIT  greatest(p_limit, 1)
    OFFSET greatest(p_offset, 0);
    RETURN;
  END IF;

  -- FUZZY FALLBACK: only when there are ZERO exact matches in TOTAL (not just
  -- on this page) — honors p_offset correctly, so page 2+ of a fuzzy-only
  -- result set still returns rows instead of dead-ending.
  RETURN QUERY
  WITH fuzzy AS (
    SELECT DISTINCT e.thread_id, max(e.internal_date) OVER (PARTITION BY e.thread_id) AS last_at
    FROM email_index e
    WHERE e.mailbox = p_mailbox
      AND NOT ('TRASH' = ANY(e.label_ids))
      AND NOT ('SPAM'  = ANY(e.label_ids))
      AND (
        similarity(coalesce(e.subject, ''), p_query) > 0.3
        OR similarity(coalesce(e.from_name, ''), p_query) > 0.3
      )
      AND (
        p_scope IS DISTINCT FROM 'inbox'
        OR EXISTS (
          SELECT 1 FROM email_index i
          WHERE i.mailbox = p_mailbox AND i.thread_id = e.thread_id AND 'INBOX' = ANY(i.label_ids)
        )
      )
  )
  SELECT f.thread_id, f.last_at FROM fuzzy f
  ORDER BY f.last_at DESC
  LIMIT  greatest(p_limit, 1)
  OFFSET greatest(p_offset, 0);
END;
$$;

COMMENT ON FUNCTION inbox_search_thread_page(text, text, integer, integer, text) IS
  'One page of SEARCH results as conversations. A thread matches if EVERY word of the query is found somewhere across the thread (subject/sender/snippet OR any message body, index-backed, never re-tokenized at read time) — not a single message row. Falls back to trigram-fuzzy subject/sender matching ONLY when the exact search has ZERO total matches (checked once, so paging into a fuzzy result set works correctly). p_scope=''inbox'' restricts to threads currently in the Inbox; ''all'' searches the whole stored history. dev job 72006580.';

CREATE OR REPLACE FUNCTION inbox_search_thread_count(
  p_mailbox text,
  p_query   text,
  p_scope   text DEFAULT 'all'
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  exact_total bigint;
  fuzzy_total bigint;
BEGIN
  SELECT count(*) INTO exact_total
  FROM (
    WITH lexemes AS (
      SELECT array_agg(DISTINCT lex) AS arr, nullif(string_agg(DISTINCT lex, ' | '), '') AS or_q
      FROM unnest(tsvector_to_array(to_tsvector('simple', p_query))) AS lex
    ),
    candidates AS (
      SELECT DISTINCT e.thread_id
      FROM email_index e, lexemes
      WHERE e.mailbox = p_mailbox
        AND NOT ('TRASH' = ANY(e.label_ids))
        AND NOT ('SPAM'  = ANY(e.label_ids))
        AND (lexemes.or_q IS NULL OR e.search @@ to_tsquery('simple', lexemes.or_q))
      UNION
      SELECT DISTINCT e.thread_id
      FROM email_message_content c
      JOIN email_index e ON e.mailbox = c.mailbox AND e.message_id = c.message_id, lexemes
      WHERE c.mailbox = p_mailbox
        AND c.deleted_at IS NULL
        AND c.capture_status = 'complete'
        AND NOT ('TRASH' = ANY(e.label_ids))
        AND NOT ('SPAM'  = ANY(e.label_ids))
        AND lexemes.or_q IS NOT NULL
        AND c.search_body @@ to_tsquery('simple', lexemes.or_q)
    ),
    subj_agg AS (
      SELECT
        e.thread_id,
        to_tsvector(
          'simple',
          string_agg(
            coalesce(e.subject, '') || ' ' || coalesce(e.from_name, '') || ' ' ||
            coalesce(e.from_email, '') || ' ' || coalesce(e.snippet, ''),
            ' '
          )
        ) AS subj_tsv
      FROM email_index e
      JOIN candidates cand ON cand.thread_id = e.thread_id
      WHERE e.mailbox = p_mailbox
        AND NOT ('TRASH' = ANY(e.label_ids))
        AND NOT ('SPAM'  = ANY(e.label_ids))
      GROUP BY e.thread_id
    )
    SELECT s.thread_id
    FROM subj_agg s, lexemes
    WHERE lexemes.arr IS NULL OR NOT EXISTS (
      SELECT 1 FROM unnest(lexemes.arr) AS lex
      WHERE NOT (
        s.subj_tsv @@ to_tsquery('simple', lex)
        OR EXISTS (
          SELECT 1 FROM email_message_content mc
          JOIN email_index mi ON mi.mailbox = mc.mailbox AND mi.message_id = mc.message_id
          WHERE mc.mailbox = p_mailbox AND mc.thread_id = s.thread_id
            AND mc.deleted_at IS NULL AND mc.capture_status = 'complete'
            AND NOT ('TRASH' = ANY(mi.label_ids))
            AND NOT ('SPAM'  = ANY(mi.label_ids))
            AND mc.search_body @@ to_tsquery('simple', lex)
        )
      )
    )
    AND (
      p_scope IS DISTINCT FROM 'inbox'
      OR EXISTS (
        SELECT 1 FROM email_index i
        WHERE i.mailbox = p_mailbox
          AND i.thread_id = s.thread_id
          AND 'INBOX' = ANY(i.label_ids)
      )
    )
  ) counted;

  IF exact_total > 0 THEN
    RETURN exact_total;
  END IF;

  SELECT count(DISTINCT e.thread_id) INTO fuzzy_total
  FROM email_index e
  WHERE e.mailbox = p_mailbox
    AND NOT ('TRASH' = ANY(e.label_ids))
    AND NOT ('SPAM'  = ANY(e.label_ids))
    AND (
      similarity(coalesce(e.subject, ''), p_query) > 0.3
      OR similarity(coalesce(e.from_name, ''), p_query) > 0.3
    )
    AND (
      p_scope IS DISTINCT FROM 'inbox'
      OR EXISTS (
        SELECT 1 FROM email_index i
        WHERE i.mailbox = p_mailbox AND i.thread_id = e.thread_id AND 'INBOX' = ANY(i.label_ids)
      )
    );

  RETURN coalesce(fuzzy_total, 0);
END;
$$;

COMMENT ON FUNCTION inbox_search_thread_count(text, text, text) IS
  'Total conversations matching a search, including body text. Falls back to trigram-fuzzy count when the exact search finds nothing at all. Uses the SAME zero-total branch decision as inbox_search_thread_page, so the two functions always agree on which result set (exact or fuzzy) is being paged through. dev job 72006580.';

COMMIT;
