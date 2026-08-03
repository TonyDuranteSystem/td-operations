-- INBOX PAGINATION — real page numbers (Antonio 2026-08-02).
--
-- "In Gmail I have the numbers of the pages: 1, 2, 3, 4, 5, according to how
-- many emails I have." Right. The list had a "Load older" button with an
-- arbitrary ceiling that reset to the top on every refresh — because how much
-- you had loaded lived only in the page's memory.
--
-- Paging needs the DB to return the Nth page of CONVERSATIONS. email_index holds
-- one row per MESSAGE, so a plain OFFSET over rows would split threads across
-- page boundaries (the same conversation showing on page 3 and page 4). These
-- functions collapse to one row per thread (ordered by the thread's newest
-- message) and then page over THAT — so pages are exact, stable and duplicate-free.
--
-- Both are STABLE + read-only, callable via PostgREST rpc().

-- ── One page of a folder view (Inbox / Sent / a user label) ─────────────────
CREATE OR REPLACE FUNCTION inbox_thread_page(
  p_mailbox text,
  p_label   text,
  p_limit   integer,
  p_offset  integer
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
    AND p_label = ANY(e.label_ids)
    -- Trash/Spam are hidden unless that IS the folder being viewed
    AND (p_label = 'TRASH' OR NOT ('TRASH' = ANY(e.label_ids)))
    AND (p_label = 'SPAM'  OR NOT ('SPAM'  = ANY(e.label_ids)))
  GROUP BY e.thread_id
  ORDER BY max(e.internal_date) DESC
  LIMIT  greatest(p_limit, 1)
  OFFSET greatest(p_offset, 0);
$$;

COMMENT ON FUNCTION inbox_thread_page IS
  'One page of inbox CONVERSATIONS (deduped threads, newest first) for a folder. Powers real page numbers in the CRM inbox — no ceiling, no cross-page duplicates. dev_task 01800da8.';

-- ── Total conversations in a folder (for "page 1 of N") ────────────────────
CREATE OR REPLACE FUNCTION inbox_thread_count(
  p_mailbox text,
  p_label   text
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
    AND p_label = ANY(e.label_ids)
    AND (p_label = 'TRASH' OR NOT ('TRASH' = ANY(e.label_ids)))
    AND (p_label = 'SPAM'  OR NOT ('SPAM'  = ANY(e.label_ids)));
$$;

COMMENT ON FUNCTION inbox_thread_count IS
  'How many conversations a folder holds — the N in "page 1 of N". dev_task 01800da8.';

-- ── Same, for a search query (tsvector over the index) ─────────────────────
CREATE OR REPLACE FUNCTION inbox_search_thread_page(
  p_mailbox text,
  p_query   text,
  p_limit   integer,
  p_offset  integer
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
  GROUP BY e.thread_id
  ORDER BY max(e.internal_date) DESC
  LIMIT  greatest(p_limit, 1)
  OFFSET greatest(p_offset, 0);
$$;

COMMENT ON FUNCTION inbox_search_thread_page IS
  'One page of SEARCH results as conversations. Search reads our own index, so results reach the whole stored history (no 50/400 cap). dev_task 01800da8.';

CREATE OR REPLACE FUNCTION inbox_search_thread_count(
  p_mailbox text,
  p_query   text
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
    AND NOT ('SPAM'  = ANY(e.label_ids));
$$;

COMMENT ON FUNCTION inbox_search_thread_count IS
  'How many conversations match a search — the N in "page 1 of N". dev_task 01800da8.';

-- Index that makes the folder page/count fast on a growing table.
CREATE INDEX IF NOT EXISTS idx_email_index_labels_gin ON email_index USING GIN (label_ids);
