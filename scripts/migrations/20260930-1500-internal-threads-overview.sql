-- Team threads list in ONE request (2026-09-30). Sandbox first (R105). Idempotent.
-- The Portal Chats screen's GET /api/internal/threads used to run, per thread, separate requests for the account name,
-- the contact name, the unread count, the last message and the source message (hundreds of database requests per refresh;
-- ~65% of all production API requests — the Supabase egress quota was exceeded 4 Sep–4 Oct). This function returns the
-- SAME fields in one request. Semantics are copied from the route on purpose (NOT get_team_threads, whose "unread" is a
-- different model): unread = messages not sent by me with read_at IS NULL (deleted ones included); last message = the
-- newest message of the thread (deleted ones included); the list = the 100 newest threads by created_at.
BEGIN;

CREATE OR REPLACE FUNCTION public.internal_threads_overview(p_user_id uuid, p_limit integer DEFAULT 100)
RETURNS TABLE (
  thread           jsonb,
  account_name     text,
  contact_name     text,
  unread_count     bigint,
  last_message_at  timestamptz,
  last_message     text,
  source_message   text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT
    to_jsonb(t.*),
    a.company_name,
    c.full_name,
    (SELECT count(*) FROM internal_messages m
      WHERE m.thread_id = t.id AND m.sender_id <> p_user_id AND m.read_at IS NULL),
    lm.created_at,
    left(lm.message, 160),   -- the screen shows 80 JS characters; 160 characters always contain them, so the preview is identical and the answer stays small
    pm.message
  FROM (SELECT * FROM internal_threads ORDER BY created_at DESC LIMIT greatest(p_limit, 1)) t
  LEFT JOIN accounts a  ON a.id = t.account_id
  LEFT JOIN contacts c  ON c.id = t.contact_id
  LEFT JOIN portal_messages pm ON pm.id = t.source_message_id
  LEFT JOIN LATERAL (
    SELECT m.created_at, m.message FROM internal_messages m
     WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1
  ) lm ON true
  ORDER BY t.created_at DESC
$$;

REVOKE ALL ON FUNCTION public.internal_threads_overview(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.internal_threads_overview(uuid, integer) TO service_role;

COMMIT;
