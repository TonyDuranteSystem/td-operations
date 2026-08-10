-- WS-C payment plans — a voided part must be re-raisable.
--
-- THE BUG THIS FIXES (found by the System Counselor before the raise action was built,
-- confirmed by reading the live index on production):
--
--   The uniqueness that stops one part of a split setup fee being invoiced twice was written
--   as "any row that is not Cancelled". But cancelling is not the only way an invoice dies:
--   voiding it from the CRM writes 'Voided', and turning it into a credit note writes 'Credit'.
--   Both are live, used statuses on production today (Voided 3, Credit 16, Cancelled 55).
--
--   So: raise part two, send it, then void it because it was wrong — and the slot stays
--   occupied for ever. That part can never be raised again, on that offer, by anyone. The only
--   escape would be editing the dead row by hand, which is exactly the kind of surgery this
--   index existed to make unnecessary.
--
-- SECOND HOLE IN THE SAME PREDICATE, found while fixing the first: in SQL, NULL <> 'Cancelled'
-- is NULL, not true, so a row with no invoice_status fell OUT of the index entirely and got no
-- uniqueness at all. 56 rows on production carry a null invoice_status. Nothing writes a tranche
-- with a null status today, but a predicate that silently stops protecting on a null is a trap
-- rather than a guard, so it now treats "no status" as live.
--
-- The exclusion list is deliberately the DEAD statuses, not the live ones: a new live status
-- (a future 'Scheduled', say) should be protected by default. Being wrong in that direction
-- refuses a duplicate; being wrong the other way permits one.
--
-- Idempotent, and safe to run against a table that already holds tranche rows: widening which
-- rows the index covers can only ADD uniqueness, and production carries no tranche rows yet
-- (verified: payment_plan is non-null on zero offers).

DROP INDEX IF EXISTS uq_payments_one_invoice_per_tranche;

CREATE UNIQUE INDEX uq_payments_one_invoice_per_tranche
  ON public.payments (tranche_offer_token, tranche_seq)
  WHERE tranche_offer_token IS NOT NULL
    AND COALESCE(invoice_status, '') NOT IN ('Cancelled', 'Voided', 'Credit');

COMMENT ON INDEX uq_payments_one_invoice_per_tranche IS
  'One LIVE invoice per part of a payment plan. Dead invoices (Cancelled/Voided/Credit) release the slot so the part can be raised again; a null status counts as live.';
