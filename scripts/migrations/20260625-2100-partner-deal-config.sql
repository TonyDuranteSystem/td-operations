-- Partner deal configuration (Slice 1)
-- Feature: a managed partner can sell a TD service at a custom price with a
-- custom split — a setup share (one-time) + a renewal share (recurring every
-- year the client renews). Terms are set per sale.
--
-- No new tables: the account↔partner link already exists (accounts.partner_id)
-- and payouts already live in referral_payouts (partner_id, payout_type,
-- currency, payment_id, status/approved/paid). We add only:
--   1. accounts.partner_deal — durable per-account deal terms, so a renewal
--      payout years later still knows the amount. Shape:
--      { setup_payout, renewal_payout, currency, offer_token }
--   2. offers.partner_renewal_payout — the renewal share captured at sale time
--      (the setup share reuses the existing offers.partner_payout_rate via the
--      flat_fee model). Persisted onto accounts.partner_deal at activation.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS partner_deal jsonb;

COMMENT ON COLUMN accounts.partner_deal IS
  'Per-sale partner deal terms set at activation: {setup_payout, renewal_payout, currency, offer_token}. Linked partner = accounts.partner_id. Drives the recurring renewal partner payout (referral_payouts).';

ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS partner_renewal_payout numeric;

COMMENT ON COLUMN offers.partner_renewal_payout IS
  'Partner''s recurring renewal share for this sale (deal currency, default USD). Setup share = offers.partner_payout_rate (flat_fee model). Persisted to accounts.partner_deal at activation.';
