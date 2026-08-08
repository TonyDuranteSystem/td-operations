-- WS-A (dev job c0a61e44): DISPLAY-ONLY credit fields on the offer.
--
-- The MONEY lives in the credit-note ledger and is applied by the netting
-- engine at invoice creation. These two columns exist so the offer page and the
-- contract can SHOW "− €257 already paid (Paid Strategy Call)" and a net total.
-- If they are ever wrong, stale, or dropped by a revision, the client's balance
-- is still correct — which is exactly why the money was NOT put here.
--
-- Credit lines are deliberately NOT written into cost_summary: two contract
-- templates read that array POSITIONALLY (renewal items [0]/[1], the
-- installment JSON builder), so inserting a row there would corrupt rendered
-- installments. Display reads these scalars instead.

ALTER TABLE offers ADD COLUMN IF NOT EXISTS credit_amount numeric;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS credit_payment_id uuid;

COMMENT ON COLUMN offers.credit_amount IS
  'WS-A display-only: credit amount shown on the offer/contract ("already paid"). The authoritative money is the credit-note payments row; netting applies it at invoice creation.';
COMMENT ON COLUMN offers.credit_payment_id IS
  'WS-A display-only: the credit-note payments row this offer references, for staff traceability. Never used to compute a balance.';
