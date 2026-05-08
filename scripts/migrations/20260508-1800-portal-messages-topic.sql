-- Migration: add topic column to portal_messages + create get_portal_chat_threads_v2
-- Applied to sandbox first per R105.
--
-- 1. topic column: freeform text label set by the client on each message.
--    Nullable — all existing messages stay valid (NULL = no topic).
--    No enum: client types whatever they want; autocomplete handled in the UI.
--
-- 2. get_portal_chat_threads_v2: the admin threads API calls this function
--    but only get_portal_chat_threads_unified exists in the DB.
--    Created here as a thin wrapper so both names work.

ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS topic TEXT;

COMMENT ON COLUMN portal_messages.topic IS
  '2026-05-08 — Freeform topic label set by the client sender.
   NULL = no topic (all legacy messages). Admin messages never set this field
   (admin view is read-only per Antonio decision 2026-05-08).
   Notification throttle key: topic || contact_id (per-topic 2h window).';

CREATE OR REPLACE FUNCTION get_portal_chat_threads_v2()
RETURNS TABLE (
  contact_id      UUID,
  contact_name    TEXT,
  account_id      UUID,
  companies       JSONB,
  members         JSONB,
  last_message    TEXT,
  last_message_at TIMESTAMPTZ,
  unread_count    BIGINT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
AS $$
  SELECT * FROM get_portal_chat_threads_unified();
$$;

COMMENT ON FUNCTION get_portal_chat_threads_v2 IS
  '2026-05-08 — Alias for get_portal_chat_threads_unified.
   The admin threads API route calls this name; unified() holds the actual logic.';
