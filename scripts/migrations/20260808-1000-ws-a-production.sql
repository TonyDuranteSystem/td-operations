-- ═══════════════════════════════════════════════════════════════════════
-- WS-A — paid strategy-call credit. PRODUCTION schema + catalog.
-- Run this FIRST, before the code is merged. Everything is additive:
-- new nullable columns and one catalog row. No existing row is touched,
-- and nothing here changes behaviour on its own — the code that uses
-- these columns is not live until the merge.
-- ═══════════════════════════════════════════════════════════════════════

-- 1. The claim lock. A credit note being used by an in-flight invoice is
--    stamped here, so two simultaneous signings cannot spend it twice.
--    Released when the invoice settles, or reaped if the process dies.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS credit_consumed_by uuid;

COMMENT ON COLUMN payments.credit_consumed_by IS
  'WS-A: transient claim lock on a credit note. Set while an invoice is being created against it; cleared on settle unless the credit is exhausted, in which case it holds that invoice id. Stale claims are released automatically on the client''s next invoice.';

-- 2-4. Display-only fields on the offer. The MONEY lives in the credit-note
--      ledger and is applied by the netting engine at invoice creation;
--      these exist so the offer and contract can SHOW the deduction.
ALTER TABLE offers ADD COLUMN IF NOT EXISTS credit_amount numeric;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS credit_payment_id uuid;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS credit_kind text;

COMMENT ON COLUMN offers.credit_amount IS
  'WS-A display-only: credit shown on the offer/contract as "already paid". The authoritative money is the credit-note payments row.';
COMMENT ON COLUMN offers.credit_payment_id IS
  'WS-A display-only: the credit note this offer references, for staff traceability. Never used to compute a balance.';
COMMENT ON COLUMN offers.credit_kind IS
  'WS-A display-only: ''paid_call'' when every credit in credit_amount is a paid strategy call, else NULL. Drives the client-facing label only.';

-- 5. The service vocabulary entry. A dedicated slug so the paid-call funnel
--    stays a clean number, separate from generic consulting. No default
--    price on purpose: amount and currency come from each booking.
INSERT INTO catalog_entries (catalog_id, slug, display_name, description, status, tags, capabilities, metadata)
VALUES (
  'services',
  'paid_strategy_call',
  'Paid Strategy Call',
  'Paid discovery/strategy call (Calendly paid booking, collected via Stripe). Amount and currency are per-booking from the payment payload — deliberately NO default price on this entry. The call fee is deductible from a subsequent service purchase via a contact-scoped credit note (WS-A, dev job c0a61e44). Dedicated slug per architect ruling so the paid-call conversion funnel stays a clean number, separate from generic consulting.',
  'active',
  '["service", "sellable", "contact_eligible"]'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFY (expect 4 columns and 1 catalog row):
--   SELECT
--     (SELECT count(*) FROM information_schema.columns
--       WHERE (table_name='payments' AND column_name='credit_consumed_by')
--          OR (table_name='offers' AND column_name IN ('credit_amount','credit_payment_id','credit_kind'))) AS columns_added,
--     (SELECT count(*) FROM catalog_entries WHERE slug='paid_strategy_call') AS catalog_row;
-- ═══════════════════════════════════════════════════════════════════════
