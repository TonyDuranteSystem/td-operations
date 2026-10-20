-- TD Marketing, Slice 2a: what a setter / the owner does with a lead (dev job 9aec66fa).
-- Adds only columns to marketing_leads: who picked the lead, the call-back time, the "not in target" reason, the checklist ticks.
-- Every change still writes a row in marketing_lead_events (append-only), so the history is never lost.
DO $$
BEGIN
  IF to_regclass('public.marketing_leads') IS NULL THEN
    RAISE EXCEPTION 'Run 20261019-1000-marketing-leads.sql FIRST: marketing_leads is missing.';
  END IF;
END $$;

ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS claimed_by          uuid;          -- the login that picked the lead (NULL = nobody yet)
ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS claimed_by_label    text;          -- his email, kept so the list can show "picked by" without a lookup
ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS claimed_at          timestamptz;
ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS callback_at         timestamptz;   -- "call back later": the day and time
ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS not_in_target_reason text;         -- a key from the not_in_target_reasons setting
ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS qualification       jsonb;         -- [{item, ticked}] as the setter saw the checklist

CREATE INDEX IF NOT EXISTS idx_marketing_leads_team_callback ON marketing_leads (team_id, callback_at) WHERE callback_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_marketing_leads_team_claimed  ON marketing_leads (team_id, claimed_by) WHERE claimed_by IS NOT NULL;

SELECT public.marketing_lock_all_tables();
