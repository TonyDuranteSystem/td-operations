-- Partner payout request + flexible referral linkage (Slice 3)
--
-- A partner's referral can be a COMPANY (account) OR an INDIVIDUAL (contact) —
-- the universal anchor is the originating OFFER (every partner deal starts as an
-- offer carrying partner_id). So payouts link flexibly via offer_token (+ the
-- optional account_id/contact_id), never account-only.
--
-- Also adds the partner self-serve payout-request fields: when the client pays
-- and Finance confirms it, the partner submits USD bank details (+ optional
-- invoice upload) from their portal to request the payout (status='requested').

ALTER TABLE referral_payouts
  ADD COLUMN IF NOT EXISTS offer_token   text,
  ADD COLUMN IF NOT EXISTS account_id    uuid,
  ADD COLUMN IF NOT EXISTS contact_id    uuid,
  ADD COLUMN IF NOT EXISTS payout_request jsonb,
  ADD COLUMN IF NOT EXISTS invoice_url   text,
  ADD COLUMN IF NOT EXISTS invoice_name  text,
  ADD COLUMN IF NOT EXISTS requested_at  timestamptz;

COMMENT ON COLUMN referral_payouts.offer_token IS
  'Originating offer token — the UNIVERSAL referral anchor (works for company OR individual referrals). account_id/contact_id are optional conveniences derived from the offer.';
COMMENT ON COLUMN referral_payouts.payout_request IS
  'Partner self-serve payout request (set when status=requested): USD bank details { account_name, account_number, iban, swift_bic, bank_name, note }.';
COMMENT ON COLUMN referral_payouts.invoice_url IS
  'Optional partner-uploaded invoice (storage URL) attached to the payout request.';

-- referral_payouts.status is free-text; the request flow adds the value
-- 'requested' (pending → requested → approved → paid). No enum/constraint change.
