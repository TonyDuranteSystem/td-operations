-- TD BOOKS — Phase 1b: add the 'transfer' category.
--
-- Stripe is a CLEARING account (the CPA's own practice — "Stripe Clearing" is an asset
-- line on the filed 2024 Schedule L): the client's charge is income (recognized from the
-- INVOICE ledger, not the bank), the payout that lands in the bank is a TRANSFER between
-- TD's own accounts, and the processing fee is an expense. Without a 'transfer' category
-- every payout deposit could only be miscategorized (income = double count) or left
-- uncategorized forever. Same category serves own-account moves (Relay↔Mercury etc.).
-- 'transfer' rows are EXCLUDED from the P&L by construction.

ALTER TABLE td_books_transactions
  DROP CONSTRAINT IF EXISTS td_books_transactions_category_check;

ALTER TABLE td_books_transactions
  ADD CONSTRAINT td_books_transactions_category_check CHECK (category = ANY (ARRAY[
    'income'::text, 'cogs'::text, 'expense'::text, 'distribution'::text,
    'contribution'::text, 'fee'::text, 'conversion'::text, 'refund'::text,
    'transfer'::text, 'uncategorized'::text
  ]));
