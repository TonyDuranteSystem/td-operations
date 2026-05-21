-- Add active_from / active_until date columns to portal_announcements
-- Allows scheduling banners to appear/disappear automatically based on date.
-- Both columns are nullable — NULL means "no limit on that side".

ALTER TABLE portal_announcements
  ADD COLUMN IF NOT EXISTS active_from DATE,
  ADD COLUMN IF NOT EXISTS active_until DATE;
