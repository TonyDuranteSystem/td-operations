-- Add lead_id to wizard_progress so a formation wizard session can be anchored
-- to a specific lead/offer instead of an existing account.
--
-- Context: existing clients who open a brand-new, unrelated company had their
-- formation wizard hijacked by the first Active account linked to their contact
-- (e.g. Adam Mihaly's new NM MMLLC pulled in THW Global LLC's EIN/name/state).
-- account_id is wrong (no account exists yet) and contact_id alone is ambiguous
-- when a contact has multiple formations in flight. lead_id is the correct anchor.
--
-- dev_task 358e8cbe — portal formation wizard fix for second company.

ALTER TABLE wizard_progress
  ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id);

CREATE INDEX IF NOT EXISTS idx_wizard_progress_lead_id
  ON wizard_progress (lead_id)
  WHERE lead_id IS NOT NULL;
