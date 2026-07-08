-- Phase B2 (2026-07-08): client-side location cards need the location stack on
-- the BOOKS path. Two additive changes:
--
-- 1. bank_transactions gains the loc_* stamp columns (same shape + CHECK as
--    pnl_workspace_transactions): loc_source 'text'|'map'|'ai', confidence
--    'high'|'medium'|'low'. Stamps arrive (a) carried from a workspace on
--    Save-to-client and (b) from deterministic inference in
--    recategorizeAccountYear. AI-place stays workspace-only (v1).
--
-- 2. pnl_period_answers becomes dual-scope: workspace_id OR account_id
--    (exactly one). Existing rows all carry workspace_id → the CHECK validates
--    them unchanged. Client (books) answers store account_id + the tax year
--    they swept (books rows have no workspace to derive it from).

ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS loc_code text;

ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS loc_source text;

ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS loc_confidence text;

ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_loc_source_check CHECK (loc_source IS NULL OR loc_source IN ('text','map','ai'));

ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_loc_confidence_check CHECK (loc_confidence IS NULL OR loc_confidence IN ('high','medium','low'));

CREATE INDEX IF NOT EXISTS idx_bank_transactions_loc ON bank_transactions (account_id, tax_year) WHERE loc_code IS NOT NULL;

ALTER TABLE pnl_period_answers ALTER COLUMN workspace_id DROP NOT NULL;

ALTER TABLE pnl_period_answers ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;

ALTER TABLE pnl_period_answers ADD COLUMN IF NOT EXISTS tax_year integer;

ALTER TABLE pnl_period_answers ADD CONSTRAINT pnl_period_answers_scope_check CHECK ((workspace_id IS NOT NULL AND account_id IS NULL) OR (workspace_id IS NULL AND account_id IS NOT NULL AND tax_year IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_pnl_period_answers_account ON pnl_period_answers (account_id, tax_year) WHERE account_id IS NOT NULL;

-- Books-path undo restore rows: pnl_period_answer_rows.transaction_id FKs to
-- pnl_workspace_transactions, so client (books) sweeps get a parallel table
-- FK'd to bank_transactions. Same shape, same cascade.
CREATE TABLE IF NOT EXISTS pnl_period_answer_book_rows (
  batch_id uuid NOT NULL REFERENCES pnl_period_answers(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  prev_category text NOT NULL,
  prev_subcategory text,
  prev_notes text,
  PRIMARY KEY (batch_id, transaction_id)
);

ALTER TABLE pnl_period_answer_book_rows ENABLE ROW LEVEL SECURITY;
