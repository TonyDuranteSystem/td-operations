-- TD Communication — chat feature parity with the portal chat
--
-- Adds the per-message columns the portal chat (portal_messages) carries, so the
-- /collab + CRM conversation chat can match it feature-for-feature: attachments,
-- replies, edit history, soft-delete (already present), pin, keep-unread, and
-- read receipts. Mirrors portal_messages column names where sensible (body is
-- this table's text column, so original_message -> original_body).
--
-- Attachments reuse the existing PUBLIC `assets` bucket under
-- comm-attachments/<conversation_id>/ (same pattern as chat-attachments/).
--
-- RLS: comm_messages already has the participant-scoped SELECT policy via
-- public.comm_can_read; these are new columns on the same rows, so no policy
-- change is needed. Realtime UPDATE already delivers edits/pins/deletes.

ALTER TABLE comm_messages
  ADD COLUMN IF NOT EXISTS attachment_url  text,
  ADD COLUMN IF NOT EXISTS attachment_name text,
  ADD COLUMN IF NOT EXISTS attachments     jsonb,
  ADD COLUMN IF NOT EXISTS read_at         timestamptz,
  ADD COLUMN IF NOT EXISTS reply_to_id     uuid REFERENCES comm_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS edited_at       timestamptz,
  ADD COLUMN IF NOT EXISTS original_body   text,
  ADD COLUMN IF NOT EXISTS pinned_at       timestamptz,
  ADD COLUMN IF NOT EXISTS pinned_by       text,
  ADD COLUMN IF NOT EXISTS pinned_by_type  text CHECK (pinned_by_type IN ('staff', 'partner')),
  ADD COLUMN IF NOT EXISTS kept_unread     boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN comm_messages.attachments IS
  'Array of { url, name, mime_type, size } — chat attachments in the public assets bucket (comm-attachments/<conversation_id>/).';
COMMENT ON COLUMN comm_messages.reply_to_id IS
  'The message this one quotes/replies to (same conversation).';
COMMENT ON COLUMN comm_messages.original_body IS
  'Pre-edit text, preserved on the first edit only; edited_at marks an edited message.';
COMMENT ON COLUMN comm_messages.read_at IS
  'When the counterpart first read this message (drives the read-receipt ✓✓).';
COMMENT ON COLUMN comm_messages.kept_unread IS
  'Recipient deliberately re-marked this message unread so it keeps counting toward the badge.';

-- Helpful partial index for unread-counting (staff badge / per-conversation unread).
CREATE INDEX IF NOT EXISTS idx_comm_messages_unread
  ON comm_messages (conversation_id)
  WHERE read_at IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_comm_messages_pinned
  ON comm_messages (conversation_id)
  WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;
