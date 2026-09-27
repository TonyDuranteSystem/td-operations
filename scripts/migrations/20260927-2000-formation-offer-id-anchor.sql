-- Workspace-only plan S1 (dev job 9d34e750, Antonio 2026-09-27): no automatic
-- lead. An existing client buying a NEW company from their contact page is not
-- a lead, so formation — like onboarding already does since dev job bc2a8f7f —
-- anchors "which company is this formation for" on the OFFER itself.
-- A first-time client's formation still has its real lead; lead_id stays for
-- origin/reporting, the offer is the anchor. Idempotent.

ALTER TABLE formation_submissions ADD COLUMN IF NOT EXISTS offer_id uuid REFERENCES offers(id);

COMMENT ON COLUMN formation_submissions.offer_id IS
  'The specific formation offer this submission is for — the anchor for "which new company". Works whether the offer came through a lead (first company) or was created on an existing contact (no lead). lead_id is origin/reporting only.';

SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'formation_submissions' AND column_name = 'offer_id';
