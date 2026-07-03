-- TD Communication Phase 13 — Revenue & Payouts
--
-- Adds the money layer to td_comm_enrollments. NO new tables:
--   • Cris's payouts reuse `referral_payouts` (payout_type='td_comm', referral_id IS NULL).
--   • Client billing reuses `payments` via createTDInvoice (payment_category='td_communication').
--   • Payout expense reuses `td_expenses` (recorded on mark-paid).
--
-- Two-stage model: an earning is RECOGNIZED when the project first reaches
-- 'approved'/'delivered' (earning_locked_at), and becomes WITHDRAWABLE only once
-- the client has paid (linked payments row status='Paid', or the admin override).
--
-- Idempotent (IF NOT EXISTS + DO-block constraint + IS NULL backfills) so the same
-- file applies cleanly to the local stack, the cloud sandbox, and production.

-- 1) Columns -----------------------------------------------------------------
ALTER TABLE td_comm_enrollments
  ADD COLUMN IF NOT EXISTS partner_amount_usd      numeric(12,2),
  ADD COLUMN IF NOT EXISTS earning_locked_at       timestamptz,
  ADD COLUMN IF NOT EXISTS worker_partner_id       uuid REFERENCES client_partners(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS client_payment_id       uuid REFERENCES payments(id)         ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS client_paid_override_at timestamptz,
  ADD COLUMN IF NOT EXISTS client_paid_override_by text;

-- Non-negative earning (idempotent add).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'td_comm_enrollments_partner_amount_nonneg'
  ) THEN
    ALTER TABLE td_comm_enrollments
      ADD CONSTRAINT td_comm_enrollments_partner_amount_nonneg
      CHECK (partner_amount_usd IS NULL OR partner_amount_usd >= 0);
  END IF;
END $$;

COMMENT ON COLUMN td_comm_enrollments.partner_amount_usd IS
  'Phase 13: what the TD Communication worker (Cris) earns for this project. Set manually by admin (USD).';
COMMENT ON COLUMN td_comm_enrollments.earning_locked_at IS
  'Phase 13: stamped once when the project first reaches approved/delivered. NULL = earning not yet recognized.';
COMMENT ON COLUMN td_comm_enrollments.worker_partner_id IS
  'Phase 13: the partner who does the work (Cris) — distinct from partner_id (the polymorphic client subject). Earnings attribute to this partner.';
COMMENT ON COLUMN td_comm_enrollments.client_payment_id IS
  'Phase 13: the linked payments row (TD invoice, payment_category=td_communication). Its total = frozen agreed price; status=Paid gates payout availability.';
COMMENT ON COLUMN td_comm_enrollments.client_paid_override_at IS
  'Phase 13: admin "client paid off-platform" override — an alternative availability gate to a Paid invoice.';

-- 2) Indexes -----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_td_comm_enrollments_worker_partner
  ON td_comm_enrollments (worker_partner_id);
CREATE INDEX IF NOT EXISTS idx_td_comm_enrollments_client_payment
  ON td_comm_enrollments (client_payment_id);

-- 3) Allow the td_communication billing category ----------------------------
-- createTDInvoice tags branding invoices payment_category='td_communication' so
-- they are distinctly identifiable in the receivables ledger. Additive to the
-- existing allow-list CHECK — no existing row violates it, no existing code breaks.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_category_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_category_check
  CHECK (payment_category IS NULL OR payment_category = ANY (ARRAY[
    'setup_fee','installment_1','installment_2','annual_renewal','one_time',
    'itin','custom','credit','other','td_communication'
  ]::text[]));

-- 4) Backfill 1 — worker attribution -----------------------------------------
-- Match by explicit partner email (no-op in any environment where that partner
-- does not exist, e.g. a fresh sandbox), same precedent as the display_title seed.
UPDATE td_comm_enrollments e
  SET worker_partner_id = p.id
  FROM client_partners p
  WHERE p.partner_email = 'cristian@sirioos.design'
    AND e.worker_partner_id IS NULL;

-- 5) Backfill 2 — recognize existing completed work --------------------------
-- Without this, projects already at approved/delivered would never re-fire the
-- recognition chokepoints (forward-only), so Cris could never be paid for past
-- work. Recognize them at their last-updated moment.
UPDATE td_comm_enrollments
  SET earning_locked_at = COALESCE(updated_at, created_at)
  WHERE status IN ('approved', 'delivered')
    AND earning_locked_at IS NULL;
