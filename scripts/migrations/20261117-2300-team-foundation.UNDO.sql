-- Undo of 20261117-2300-team-foundation.sql.
-- WARNING: dropping portal_team_events erases the team action history. Only for a sandbox reset.
DROP TABLE IF EXISTS portal_team_events;
DROP FUNCTION IF EXISTS public.trg_portal_team_events_guard();
DROP FUNCTION IF EXISTS public.trg_portal_team_events_no_truncate();
ALTER TABLE portal_team_members DROP CONSTRAINT IF EXISTS ptm_switched_off_shape;
ALTER TABLE portal_team_members
  DROP COLUMN IF EXISTS notice_version,
  DROP COLUMN IF EXISTS notice_accepted_at,
  DROP COLUMN IF EXISTS notice_accepted_ip,
  DROP COLUMN IF EXISTS switched_off_by,
  DROP COLUMN IF EXISTS switched_off_at,
  DROP COLUMN IF EXISTS switched_off_reason;
