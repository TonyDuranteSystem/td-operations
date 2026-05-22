-- Notification Center Phase 1 — staff-only action cards on message_actions
-- See sysdoc 'notification-center-plan' (dev_task 529b26cc).
--
-- Adds an owner (assigned_to) and an idempotency key (source_ref) so fresh
-- client-action events can create STAFF-ONLY kanban cards. These cards reuse
-- message_actions with message_id = NULL — nothing is ever written to the
-- client's chat thread. Additive + idempotent: safe to re-run.

ALTER TABLE message_actions
  ADD COLUMN IF NOT EXISTS assigned_to text,
  ADD COLUMN IF NOT EXISTS source_ref  text;

-- Idempotency lookup: "is there already an OPEN card for this event source?"
CREATE INDEX IF NOT EXISTS idx_message_actions_source_ref_open
  ON message_actions (source_ref)
  WHERE source_ref IS NOT NULL AND resolved_at IS NULL;

-- Board feed: open cards, newest first.
CREATE INDEX IF NOT EXISTS idx_message_actions_open
  ON message_actions (created_at DESC)
  WHERE resolved_at IS NULL;
