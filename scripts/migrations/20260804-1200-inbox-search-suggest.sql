-- INBOX SEARCH TYPE-AHEAD (Antonio 2026-08-04: "when I search for an email for
-- name, email or any other words in the search tab I want the list in dropdown").
--
-- The existing search (inbox_search_thread_page) answers the FULL result list on
-- Enter, matching whole words via websearch_to_tsquery. That is wrong for a
-- dropdown: measured on production 2026-08-04, 'anto' matched 0 rows while
-- 'antonio' matched 2,473 — so a dropdown built on it would stay empty until you
-- finished the word. This function is the type-ahead sibling: PREFIX matching on
-- the word still under the cursor, message-level rows (the dropdown shows sender
-- + subject + date, not just a thread id), newest first, one row per thread.
--
-- p_tsquery is a PRE-BUILT tsquery string from buildPrefixTsQuery()
-- (lib/inbox/search-suggest.ts), which strips everything except letters and
-- digits. That sanitising is the contract: to_tsquery RAISES on malformed
-- syntax, so an unescaped apostrophe would turn a keystroke into a 500.
--
-- COST IS BOUNDED, deliberately. A one-letter prefix like 'a:*' matches most of
-- the mailbox, so the scan takes the 200 most recent matches FIRST and only then
-- collapses them to one row per thread. Without that inner bound, deduplicating
-- tens of thousands of rows would run on every keystroke.

CREATE OR REPLACE FUNCTION inbox_search_suggest(
  p_mailbox text,
  p_tsquery text,
  p_limit   integer
)
RETURNS TABLE (
  message_id     text,
  thread_id      text,
  subject        text,
  from_name      text,
  from_email     text,
  internal_date  timestamptz,
  has_attachment boolean,
  is_unread      boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT d.message_id, d.thread_id, d.subject, d.from_name, d.from_email,
         d.internal_date, d.has_attachment, d.is_unread
  FROM (
    SELECT DISTINCT ON (c.thread_id)
           c.message_id, c.thread_id, c.subject, c.from_name, c.from_email,
           c.internal_date, c.has_attachment, c.is_unread
    FROM (
      SELECT e.message_id, e.thread_id, e.subject, e.from_name, e.from_email,
             e.internal_date, e.has_attachment, e.is_unread
      FROM email_index e
      WHERE e.mailbox = p_mailbox
        AND e.search @@ to_tsquery('simple', p_tsquery)
        -- Deleted and spam stay out of suggestions, exactly as they stay out of
        -- the list — a dropdown is not a back door into the bin.
        AND NOT ('TRASH' = ANY(e.label_ids))
        AND NOT ('SPAM'  = ANY(e.label_ids))
      ORDER BY e.internal_date DESC
      LIMIT 200
    ) c
    ORDER BY c.thread_id, c.internal_date DESC
  ) d
  ORDER BY d.internal_date DESC
  LIMIT greatest(p_limit, 1);
$$;

COMMENT ON FUNCTION inbox_search_suggest(text, text, integer) IS
  'Inbox search type-ahead: prefix-matched, message-level, one row per thread, newest first, TRASH/SPAM excluded. Takes a PRE-BUILT tsquery from buildPrefixTsQuery() in lib/inbox/search-suggest.ts (sanitised to letters+digits — to_tsquery raises on malformed input). Inner LIMIT 200 bounds the per-keystroke cost of a broad prefix. Sibling of inbox_search_thread_page, which still answers the full Enter-key result list.';
