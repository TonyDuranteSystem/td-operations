-- Undo for 20261019-2300-marketing-setter-actions.sql. Loses who-picked-what, call-back times and checklist ticks (the history rows stay).
DROP INDEX IF EXISTS idx_marketing_leads_team_callback;
DROP INDEX IF EXISTS idx_marketing_leads_team_claimed;
ALTER TABLE marketing_leads DROP COLUMN IF EXISTS claimed_by;
ALTER TABLE marketing_leads DROP COLUMN IF EXISTS claimed_by_label;
ALTER TABLE marketing_leads DROP COLUMN IF EXISTS claimed_at;
ALTER TABLE marketing_leads DROP COLUMN IF EXISTS callback_at;
ALTER TABLE marketing_leads DROP COLUMN IF EXISTS not_in_target_reason;
ALTER TABLE marketing_leads DROP COLUMN IF EXISTS qualification;
