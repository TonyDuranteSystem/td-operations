-- 20260509-0003-transaction-override-payout.sql
-- Partner Portal Phase 1, Migration 3/3.
-- Per-transaction partner overrides on offers, plus payout lifecycle on
-- referral_payouts. partner_id columns reference the canonical client_partners
-- table.

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS partner_id              UUID REFERENCES public.client_partners(id),
  ADD COLUMN IF NOT EXISTS partner_invoice_target  TEXT,
  ADD COLUMN IF NOT EXISTS partner_agreed_price    NUMERIC,
  ADD COLUMN IF NOT EXISTS partner_payout_model    TEXT,
  ADD COLUMN IF NOT EXISTS partner_payout_rate     NUMERIC;

ALTER TABLE public.referral_payouts
  ADD COLUMN IF NOT EXISTS partner_id     UUID REFERENCES public.client_partners(id),
  ADD COLUMN IF NOT EXISTS status         TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS approved_by    UUID,
  ADD COLUMN IF NOT EXISTS approved_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payout_method  TEXT;
