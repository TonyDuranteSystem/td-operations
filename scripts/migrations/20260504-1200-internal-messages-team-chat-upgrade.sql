-- 20260504-1200-internal-messages-team-chat-upgrade.sql
-- Adds reply threading, soft delete, multi-file attachments, and read receipts
-- to internal_messages (team chat between Antonio and Luca).

ALTER TABLE internal_messages
  ADD COLUMN IF NOT EXISTS reply_to_id   UUID        REFERENCES internal_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by    UUID,
  ADD COLUMN IF NOT EXISTS attachments   JSONB,
  ADD COLUMN IF NOT EXISTS seen_at       TIMESTAMPTZ;

-- Speed up reply lookups
CREATE INDEX IF NOT EXISTS idx_internal_messages_reply_to
  ON internal_messages(reply_to_id)
  WHERE reply_to_id IS NOT NULL;

-- Partial index: most queries filter out deleted messages
CREATE INDEX IF NOT EXISTS idx_internal_messages_active
  ON internal_messages(thread_id, created_at)
  WHERE deleted_at IS NULL;
