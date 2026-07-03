-- Client-level dated payment-reminder pause ("client promised to pay by <date>").
-- Feature: visible invoice notes + reminder pause (Luca's 2026-07-03 request,
-- KG Wolf incident — reminders sent to a client who had promised payment).
--
-- Sits next to the existing boolean accounts.dunning_pause (indefinite pause).
-- The dated pause expires by itself: while dunning_pause_until >= today, the
-- dunning cron and bulk reminders skip ALL the account's invoices and the
-- manual single-send requires an explicit "send anyway". It never suppresses
-- Overdue marking — only reminders.
--
-- dunning_pause_reason is the human trace ("promised payment by end of Sept"),
-- shown in the account's Payment Reminder Settings section.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dunning_pause_until date;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS dunning_pause_reason text;

COMMENT ON COLUMN accounts.dunning_pause_until IS
  'Pause ALL payment reminders for this client until this date inclusive (auto-expires). Set when the client promises to pay by a date. Gates reminders only, never Overdue marking. 2026-07-03.';
COMMENT ON COLUMN accounts.dunning_pause_reason IS
  'Free-text reason/trace for dunning_pause_until (e.g. "client promised payment by end of September"). 2026-07-03.';
