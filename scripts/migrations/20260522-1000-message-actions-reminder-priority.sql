-- migration:20260522-1000-message-actions-reminder-priority.sql
--
-- Notification Center Phase 1b — give staff action cards a REMINDER date and a
-- PRIORITY. Both drive the board (overdue / high-priority cards float up and
-- colour) and the new PURPLE per-thread dot in portal-chats. Driven entirely by
-- message_actions — NOT the tasks table (Antonio is retiring the task board).
--
-- remind_at : optional visible "do this by" date/time. No cron/email in Phase 1;
--             purely visual (card colours amber/red when due/overdue, sorts up).
-- priority  : normal | high | urgent. High/urgent colour the card + the dot and
--             sort to the top of their column.
--
-- See sysdoc notification-center-plan. Sandbox first (R105).

ALTER TABLE message_actions
  ADD COLUMN IF NOT EXISTS remind_at timestamptz,
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';

-- Constrain priority to the three known values. Named constraint so it is
-- idempotent-droppable on re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_actions_priority_check'
  ) THEN
    ALTER TABLE message_actions
      ADD CONSTRAINT message_actions_priority_check
      CHECK (priority IN ('normal', 'high', 'urgent'));
  END IF;
END $$;

-- Partial index: the board + the purple-dot query both filter to OPEN cards and
-- want the soonest reminder first.
CREATE INDEX IF NOT EXISTS idx_message_actions_open_remind_at
  ON message_actions (remind_at)
  WHERE resolved_at IS NULL;
