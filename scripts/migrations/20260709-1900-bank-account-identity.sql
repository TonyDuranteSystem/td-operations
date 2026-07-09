-- Bank Account Identity — add the client-confirmed account identity key.
-- Feature: sysdoc `pnl-bank-account-identity-plan`, dev_task 339612ec.
--
-- `account_ref` is the engine's per-account grouping key, replacing the fragile
-- `bank_name + currency` identity that let one real account split into two when
-- its bank name was read inconsistently (Chase vs "JPMorgan Chase Bank, N.A.").
-- Built by lib/tax/bank-identity.ts::buildAccountRef:
--   account_number-mode institutions → `${canonical}#${last4}`  (currency still sub-divides)
--   currency / crypto institutions   → `${canonical}`           (currency sub-divides via account_type)
-- Nullable: written at ingest going forward, backfilled for existing rows by the
-- one-time history-cleanup step. Currency continues to live in `account_type`.

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS account_ref text;

ALTER TABLE pnl_workspace_transactions
  ADD COLUMN IF NOT EXISTS account_ref text;

-- Supports the per-account grouping scans and the backfill.
CREATE INDEX IF NOT EXISTS idx_bank_transactions_account_ref
  ON bank_transactions (account_id, tax_year, account_ref);

CREATE INDEX IF NOT EXISTS idx_pnl_workspace_transactions_account_ref
  ON pnl_workspace_transactions (workspace_id, tax_year, account_ref);
