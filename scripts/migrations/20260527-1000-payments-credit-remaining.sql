-- Credit netting: track how much of a credit note is still available to apply.
-- A credit note is a negative-total payments row (invoice_status='Credit'). As it
-- is applied against invoices, credit_remaining is decremented; leftover carries
-- to the next invoice. NULL = not a credit / not tracked.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS credit_remaining numeric;

-- Backfill: existing credit notes start fully available (their full absolute value).
UPDATE payments
  SET credit_remaining = ABS(total)
  WHERE invoice_status = 'Credit'
    AND total < 0
    AND credit_remaining IS NULL;

-- Fast lookup of an account's outstanding credits during invoice generation.
CREATE INDEX IF NOT EXISTS idx_payments_outstanding_credit
  ON payments (account_id, amount_currency)
  WHERE invoice_status = 'Credit' AND credit_remaining > 0;
