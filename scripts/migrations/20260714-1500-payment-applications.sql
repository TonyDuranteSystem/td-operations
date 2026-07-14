-- Payment applications ledger — the double-credit guard.
--
-- WHY (2026-07-14, Simple Holdings / Fazekas incident):
-- Bank-feed settlement is moving from "overwrite amount_paid" to "ACCUMULATE
-- amount_paid" (the overwrite silently erased partial payments: a $500 invoice
-- with $300 paid, settled by a $200 wire, ended up recording $200 paid — the
-- $300 vanished). Accumulation without a per-(feed, invoice) guard is strictly
-- MORE dangerous than the overwrite: a double-click, a cron re-run, or a retried
-- webhook would add the same money twice.
--
-- Today the only guard is an implicit one — the second pass sees the invoice is
-- already 'Paid' and skips. That guard evaporates for PARTIAL invoices (not a
-- terminal status), and `manualMatch` (single-invoice) has no already-matched
-- feed check at all (only `manualMatchMulti` does).
--
-- This table IS the invariant: money from one bank transaction can be applied to
-- one invoice EXACTLY ONCE. The UNIQUE constraint makes it a database fact, not
-- an application-code promise. The settler inserts here FIRST; a unique violation
-- means "already applied" and the money write is skipped.
--
-- Mandated by both adversarial supervisors as a blocker for the smarter matching
-- (payment-intent link + email identity), which increase auto-settle volume.

CREATE TABLE IF NOT EXISTS payment_applications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id     UUID NOT NULL REFERENCES td_bank_feeds(id) ON DELETE CASCADE,
  payment_id  UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  amount      NUMERIC NOT NULL,
  applied_by  TEXT,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- THE invariant: one bank transaction credits one invoice at most once.
  CONSTRAINT uq_payment_applications_feed_payment UNIQUE (feed_id, payment_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_applications_payment
  ON payment_applications (payment_id);

CREATE INDEX IF NOT EXISTS idx_payment_applications_feed
  ON payment_applications (feed_id);

COMMENT ON TABLE payment_applications IS
  'Ledger of money applied from a bank feed to an invoice. UNIQUE(feed_id, payment_id) is the double-credit guard: amount_paid accumulates, so the same feed must never credit the same invoice twice. Written inside settleInvoiceFromFeed / applyMoneyToInvoice.';

ALTER TABLE payment_applications ENABLE ROW LEVEL SECURITY;

-- Server-only table (service_role bypasses RLS). No anon/authenticated grants —
-- clients never read this directly.
