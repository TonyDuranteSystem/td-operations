-- migration:20260523-1400-message-actions-snoozed-until.sql
--
-- Notification Center Phase 2 (P1) — SNOOZE a staff To-Do card: hide it from the
-- board / To-Do panel until a chosen date, then it reappears. Distinct from
-- remind_at (a visible "do this by" date that only COLOURS the card): snooze
-- actually HIDES the card from every open-card reader until snoozed_until passes.
--
-- A dedicated column (not reusing remind_at) keeps the two concepts independent:
-- you can have a reminder date AND a separate snooze, and clearing one never
-- touches the other.
--
-- "Open card" is now: resolved_at IS NULL AND (snoozed_until IS NULL OR
-- snoozed_until <= now()). This predicate must be applied by ALL message_actions
-- readers (board ?open=true, ?counts=true purple dot, To-Do panel, summary
-- widget) — see sysdoc notification-center-phase2-cards-summary-plan.
--
-- Snooze applies to CARDS ONLY. What's New notes (portal_messages) use "handled"
-- and are NOT affected by this column.
--
-- See sysdoc notification-center-phase2-cards-summary-plan. Sandbox first (R105).

ALTER TABLE message_actions
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;

-- Partial index: every open-card reader filters resolved_at IS NULL and now also
-- evaluates snoozed_until. Indexing snoozed_until on the open subset keeps the
-- "currently due" filter cheap.
CREATE INDEX IF NOT EXISTS idx_message_actions_open_snoozed_until
  ON message_actions (snoozed_until)
  WHERE resolved_at IS NULL;
