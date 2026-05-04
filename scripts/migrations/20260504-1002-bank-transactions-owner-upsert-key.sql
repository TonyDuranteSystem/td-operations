-- Add unique constraint enabling idempotent upserts for owner transaction imports.
-- Required by import-owner-transactions-2025.ts and /api/owner/transactions/import.
-- Only applies to rows with a non-null transaction_ref (manual imports always supply one).

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_transactions_acct_ref
  ON bank_transactions (account_id, transaction_ref)
  WHERE transaction_ref IS NOT NULL;
