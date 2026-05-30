-- migration: 20260530-2340-client-expenses-partial-balance.sql
--
-- PURPOSE
-- The portal expense mirror (client_expenses) tracked only `total` + a Paid/Pending
-- status — no partial balance. To show a client the true amount owed after a credit
-- is applied (e.g. $800 due on a $1,000 invoice with a $200 referral credit), add
-- amount_paid + amount_due, mirroring payments. Reconciliation (applying a credit to
-- an existing unpaid invoice) updates amount_due here so the portal shows the net.
--
-- SAFETY: additive columns + idempotent backfill (only fills NULLs). The portal
-- continues to work if a row's amount_due is NULL (display falls back to total).
-- Sandbox first; production via Supabase SQL editor on ship.

BEGIN;

ALTER TABLE client_expenses ADD COLUMN IF NOT EXISTS amount_paid numeric;
ALTER TABLE client_expenses ADD COLUMN IF NOT EXISTS amount_due  numeric;

-- Backfill from current status: a Paid expense is fully paid (0 due); anything else
-- owes its full total. (Existing partial states didn't exist before this column.)
UPDATE client_expenses SET
  amount_paid = CASE WHEN status = 'Paid' THEN total ELSE 0 END,
  amount_due  = CASE WHEN status = 'Paid' THEN 0 ELSE total END
WHERE amount_paid IS NULL OR amount_due IS NULL;

COMMIT;
