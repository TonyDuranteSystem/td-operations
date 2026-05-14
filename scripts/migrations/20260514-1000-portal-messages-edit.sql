-- Migration: add edit-tracking columns to portal_messages
--
-- Enables admin-side message editing in the portal-chats inbox.
-- original_message stores the text at the time of the first edit (audit trail).
-- edited_at is set when a message is edited.
--
-- Constraints:
--   - Only admin messages can be edited (enforced in API, not DB).
--   - original_message is written once (on first edit), never overwritten.

ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS original_message TEXT;

COMMENT ON COLUMN portal_messages.edited_at IS
  'Timestamp of the most recent edit. NULL = never edited.';
COMMENT ON COLUMN portal_messages.original_message IS
  'Original message text before the first edit. Preserved for audit. NULL = never edited.';
