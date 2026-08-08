-- INBOX: pinned (starred) conversations float to the top of folder views
-- (dev job 76b521ea — Antonio 2026-08-07: "pin an email that I need to work
-- on"). Pin == the Gmail star, so it syncs both ways with the Gmail app.
--
-- Same signature as the live function — CREATE OR REPLACE only, no drop, no
-- PostgREST overload hazard. Search and the Archived view deliberately stay
-- chronological; a pin is a work-queue marker for the lists you triage.

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
    AND (p_label = 'TRASH' OR NOT ('TRASH' = ANY(e.label_ids)))
    AND (p_label = 'SPAM'  OR NOT ('SPAM'  = ANY(e.label_ids)))
  GROUP BY e.thread_id
  -- Pinned first (thread-level: any message starred), newest first within
  -- each band. Applies to every folder view; pins are rare outside the Inbox
  -- so ordinary folders remain effectively chronological.
  ORDER BY bool_or('STARRED' = ANY(e.label_ids)) DESC, max(e.internal_date) DESC
  LIMIT  greatest(p_limit, 1)
  OFFSET greatest(p_offset, 0);
$$;

COMMENT ON FUNCTION inbox_thread_page(text, text, integer, integer) IS
  'One page of inbox CONVERSATIONS (deduped threads): PINNED (starred) first, then newest first. Powers real page numbers + the pin work-queue. dev jobs 01800da8 + 76b521ea.';
