-- migration: 20260529-0500-payment-category-structured-classification.sql
--
-- PURPOSE
-- Stop billing/tax/audit logic from classifying a payment by reading the
-- free-text `description`. Introduce a structured `payment_category` stamp and
-- backfill it (plus the `year` for installment rows) ONCE from the cleanest
-- signal available per row. After this, the cron, lib/tax/reactivation.ts and
-- lib/audit/billing-status.ts classify via lib/billing/payment-classification.ts
-- reading only `payment_category` + `year` — never `description`.
--
-- This is the one and only place the old description wording is read for
-- classification: a controlled, auditable backfill, not live logic.
--
-- CONTEXT (why this exists): the March-2026 bulk import injected mislabeled
-- rows and left `installment` blank on ~43% of rows and `year` null on ~77%
-- (186/187 second-installment rows had null year). Live code papered over this
-- by grepping the description. This migration replaces that with structured data.
--
-- SAFETY: additive column + CHECK; backfill is idempotent (re-runnable, only
-- touches NULLs / derivable rows). Sandbox first (psql), production only on
-- explicit "ship it".

BEGIN;

-- 1) Structured classification column. NULL = uncategorized (helper treats it
--    as "not an installment", which is the safe default).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_category TEXT;

-- 2) Constrain to a known, small, flexible vocabulary. Adding a value later is a
--    one-line migration to this CHECK + the const list in
--    lib/billing/payment-classification.ts (single code-side source of truth).
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_category_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_category_check CHECK (
  payment_category IS NULL OR payment_category IN (
    'setup_fee',
    'installment_1',
    'installment_2',
    'annual_renewal',
    'one_time',
    'itin',
    'custom',
    'credit',
    'other'
  )
);

-- 3) Backfill payment_category. Priority: structured `installment` label first,
--    description wording only as a fallback for rows where `installment` is blank.
--    Idempotent: only fills rows still NULL.

-- 3a) Credit notes (referral / manual) — their billing purpose is "credit".
UPDATE payments SET payment_category = 'credit'
 WHERE payment_category IS NULL
   AND (invoice_status = 'Credit' OR credit_for_payment_id IS NOT NULL);

-- 3b) From the structured `installment` label.
UPDATE payments SET payment_category = 'setup_fee'      WHERE payment_category IS NULL AND installment = 'Setup Fee';
UPDATE payments SET payment_category = 'installment_1'  WHERE payment_category IS NULL AND installment = 'Installment 1 (Jan)';
UPDATE payments SET payment_category = 'installment_2'  WHERE payment_category IS NULL AND installment = 'Installment 2 (Jun)';
UPDATE payments SET payment_category = 'one_time'       WHERE payment_category IS NULL AND installment ILIKE 'One-Time';
UPDATE payments SET payment_category = 'itin'           WHERE payment_category IS NULL AND installment = 'ITIN';
UPDATE payments SET payment_category = 'custom'         WHERE payment_category IS NULL AND installment = 'Custom';

-- 3c) Fallback for rows with a blank `installment`: read the description wording
--     ONE FINAL TIME (here, never again in live code).
UPDATE payments SET payment_category = 'installment_1'
 WHERE payment_category IS NULL
   AND (installment IS NULL OR installment = '')
   AND description ~* '(^|[^a-z])(first|1st)[[:space:]]+installment';
UPDATE payments SET payment_category = 'installment_2'
 WHERE payment_category IS NULL
   AND (installment IS NULL OR installment = '')
   AND description ~* '(^|[^a-z])(second|2nd)[[:space:]]+installment';
UPDATE payments SET payment_category = 'setup_fee'
 WHERE payment_category IS NULL
   AND (installment IS NULL OR installment = '')
   AND description ~* 'setup[[:space:]]+fee';

-- 4) Backfill `year` ONLY for installment rows (the rows that need year-scoped
--    classification). Other payment types keep their existing `year` untouched —
--    minimal blast radius. Derivation: a 4-digit 20xx token in the description
--    (the billing-year intent) → invoice/issue/due/paid date → created_at.
UPDATE payments
   SET year = COALESCE(
     NULLIF(substring(description from '20[0-9][0-9]'), '')::int,
     EXTRACT(YEAR FROM invoice_date)::int,
     EXTRACT(YEAR FROM issue_date)::int,
     EXTRACT(YEAR FROM due_date)::int,
     EXTRACT(YEAR FROM paid_date)::int,
     EXTRACT(YEAR FROM created_at)::int
   )
 WHERE year IS NULL
   AND payment_category IN ('installment_1', 'installment_2');

COMMIT;
