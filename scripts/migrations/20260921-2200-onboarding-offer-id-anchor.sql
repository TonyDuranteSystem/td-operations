-- Dev job bc2a8f7f — replace the lead as the "which company is this onboarding
-- for" anchor with the offer itself.
--
-- WHY: today's onboarding second-company protections (entity type resolved
-- from the signed contract, the account-hijack backstop, the client's
-- status/notification/switcher scoping) all keyed off a LEAD. That is
-- correct for a client's very FIRST company (onboarding always starts as a
-- lead the first time), but wrong for every subsequent company: once
-- someone is an existing client, staff creates the new offer directly on
-- their contact record — there is no lead at all (confirmed against real
-- production data and directly by Antonio, 2026-09-21). Every one of
-- today's fixes silently did nothing for that returning-client case.
--
-- The offer itself is the one thing that always exists the instant staff
-- creates it, whether or not a lead was involved -- exactly the role a
-- Company Formation service-delivery already plays for formation's own
-- second-company case (created at payment, before the wizard). Onboarding
-- has no early service-delivery (nothing is created until staff review, by
-- design), so the offer is the correct, and only, thing early enough to
-- anchor on.

ALTER TABLE onboarding_submissions ADD COLUMN IF NOT EXISTS offer_id uuid REFERENCES offers(id);
ALTER TABLE wizard_progress ADD COLUMN IF NOT EXISTS offer_id uuid REFERENCES offers(id);

COMMENT ON COLUMN onboarding_submissions.offer_id IS
  'The specific onboarding offer this submission is for. The real anchor for "which company" — works whether the offer came through a lead (first company) or was created directly on the contact (a returning client''s second+ company, which has no lead). lead_id is kept for reporting/origin only; do not use it to identify which company a submission belongs to.';
COMMENT ON COLUMN wizard_progress.offer_id IS
  'Same role as onboarding_submissions.offer_id — see that column''s comment. Lets a client with two simultaneous onboarding wizards (rare but real) be told apart without a lead.';
