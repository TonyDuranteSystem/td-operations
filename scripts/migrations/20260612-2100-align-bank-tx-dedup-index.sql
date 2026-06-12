-- SANDBOX-ALIGNMENT ONLY — production already has the correct index.
-- Found 2026-06-12 while replaying Antonio's 13 real wizard CSVs: sandbox's
-- dedup index was a PARTIAL 2-column variant (account_id, transaction_ref)
-- WHERE transaction_ref IS NOT NULL, while production (verified live) has the
-- 4-column UNIQUE (account_id, transaction_ref, transaction_date, amount)
-- that EVERY upsert's onConflict targets. On sandbox every bank-transaction
-- upsert errored "no unique or exclusion constraint matching the ON CONFLICT
-- specification" — 0 rows ingested from 13 perfectly-parsed files.
-- DO NOT promote to production (the index already exists there under the
-- name bank_transactions_account_id_transaction_ref_transaction_da_key).

DROP INDEX IF EXISTS public.uq_bank_transactions_acct_ref;

CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_account_id_transaction_ref_transaction_da_key
  ON public.bank_transactions USING btree (account_id, transaction_ref, transaction_date, amount);
