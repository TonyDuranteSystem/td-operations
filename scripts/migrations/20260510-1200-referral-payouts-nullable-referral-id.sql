-- 20260510-1200-referral-payouts-nullable-referral-id.sql
-- Partner Portal Phase 3 — make referral_payouts.referral_id nullable.
--
-- Why: Phase 1 added partner_id (FK to client_partners) to referral_payouts so
-- payouts can be attributed directly to a managed partner without going through
-- the legacy referrals table. The original NOT NULL constraint on referral_id
-- assumed every payout traced back to a per-deal referrals row. Partner-driven
-- payouts (originated via /portal/partner/new-request) have a partner_id but
-- no referrals row — they are not "referrer-of-a-deal" rows, they are payouts
-- owed to a partner who originated the request.
--
-- After this migration, every referral_payouts row MUST have either
-- referral_id OR partner_id set. The application enforces this; a CHECK is
-- intentionally omitted to keep the column flexible if a third payout origin
-- is added later (e.g. employee bonus payouts).

ALTER TABLE public.referral_payouts
  ALTER COLUMN referral_id DROP NOT NULL;
