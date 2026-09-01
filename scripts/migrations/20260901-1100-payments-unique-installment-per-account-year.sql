-- dev job 5817969a: ShoppyVerse LLC investigation found a duplicate 2nd-installment
-- invoice created with no idempotency_key/installment/payment_category/year, which
-- went unnoticed because the account-page badge matched by amount + description text
-- instead of a structured identity. Code-side fixes now share ONE identity — account +
-- payment_category + year — for the badge, the create-time warning, and this index.
--
-- Verified against live production data before writing this (2026-09-01): a plain
-- (account_id, payment_category, year) uniqueness check DOES currently collide on two
-- accounts (Partner Alliance LLC, Morgan & Taylor International LLC) — but both are a
-- legitimate consolidated-billing pattern: a real invoice on one account plus a $0
-- companion record on the other so cron eligibility still sees "installment paid".
-- Excluding total <= 0 rows resolves both to a single live row — re-verified with a
-- zero-row result before writing this file.
--
-- invoice_status predicate copied from the existing sibling index
-- uq_payments_one_invoice_per_tranche (20260810-0940-payments-tranche-unique-index.sql),
-- which already found and fixed the two mistakes a naive predicate makes on this exact
-- table: (1) 'Cancelled' is not the only dead status — 'Voided' and 'Credit' are both
-- live, used values on production; (2) in SQL, `invoice_status <> 'Cancelled'` is NULL
-- (not true) for a row with no invoice_status, so it silently falls OUT of the index
-- and gets no protection at all — COALESCE treats a null status as live instead.
--
-- ALSO checks payments.status = 'Cancelled' (senior-engineer council finding, 2026-09-01,
-- confirmed by reading the code): the "Change Status" cascade's voidPendingPayments option
-- (app/(dashboard)/accounts/actions.ts) sets status='Cancelled' on a Pending/Overdue payment
-- WITHOUT touching invoice_status. isLivePayment (lib/billing/payment-classification.ts) has
-- always treated either column being Cancelled as dead — this index originally checked only
-- invoice_status, so that specific cascade could leave a row the JS layer correctly calls
-- dead still occupying this index's uniqueness slot, hard-rejecting a legitimate later invoice
-- with a raw constraint error instead of the intended friendly warning. Now matches
-- isLivePayment's own two-column check exactly, by construction (both import/check against
-- the same DEAD_INVOICE_STATUSES-equivalent list).
--
-- Partial unique index (not a plain UNIQUE constraint), matching the existing pattern
-- in this schema (uq_payments_invoice_number, uq_banking_submissions_account_provider):
-- only a REAL, live installment invoice participates, so a dead or $0 placeholder row
-- never blocks a legitimate re-issue.
--
-- DROP + recreate rather than a bare IF NOT EXISTS: this migration was already applied once
-- (2026-09-01, sandbox only, never promoted to production) with a narrower predicate that
-- missed the status='Cancelled' case above — IF NOT EXISTS alone would silently keep serving
-- that stale definition (senior-engineer finding: exactly the failure mode this file's own
-- comment about IF NOT EXISTS warns against).
DROP INDEX IF EXISTS uq_payments_installment_per_account_year;

CREATE UNIQUE INDEX uq_payments_installment_per_account_year
  ON payments (account_id, payment_category, year)
  WHERE payment_category IN ('installment_1', 'installment_2')
    AND COALESCE(invoice_status, '') NOT IN ('Cancelled', 'Voided', 'Credit')
    AND COALESCE(status, '') <> 'Cancelled'
    AND total > 0;

COMMENT ON INDEX uq_payments_installment_per_account_year IS
  'One LIVE installment invoice per account+year+installment number. Dead invoices (status or invoice_status = Cancelled; invoice_status = Voided/Credit) and $0 placeholder/consolidated-billing rows release the slot; a null invoice_status counts as live.';
