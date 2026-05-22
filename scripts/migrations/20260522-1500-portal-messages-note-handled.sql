-- migration:20260522-1500-portal-messages-note-handled.sql
--
-- Notification Center — "What's New" handled state. A staff member triages an
-- incoming system note (chat-event, sender_type='system') by either opening a
-- To-Do card from it or ticking "Handled" ("seen it, no card needed"). Once
-- handled, the note stops counting toward the PURPLE per-thread dot; unticking
-- clears it and the dot returns. Driven entirely by these two columns.
--
-- Staff-only metadata on a staff-only message (system notes are hidden from the
-- client portal). No client impact. See sysdoc notification-center-plan.

ALTER TABLE portal_messages
  ADD COLUMN IF NOT EXISTS handled_at timestamptz,
  ADD COLUMN IF NOT EXISTS handled_by text;

-- Partial index: the purple-dot count query asks "unhandled system notes per
-- account/contact" — only system rows, only unhandled.
CREATE INDEX IF NOT EXISTS idx_portal_messages_unhandled_system
  ON portal_messages (account_id, contact_id)
  WHERE sender_type = 'system' AND handled_at IS NULL AND deleted_at IS NULL;
