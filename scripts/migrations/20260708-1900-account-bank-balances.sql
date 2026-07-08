-- S2 slice 2 (2026-07-08): per-bank per-currency balance anchors.
-- The client (or staff) records each bank account's OPENING and CLOSING
-- balance for the tax year — the two numbers every client can copy from their
-- statement header. The engine uses them as (a) the third beginning-cash
-- source when neither a validated prior return nor statement balance columns
-- exist, and (b) the per-bank tie-out anchor: opening + net movement must
-- equal closing, else the gate names the bank and the exact hole.
-- Balances are stored in the ACCOUNT'S OWN currency (CPA condition) and
-- converted with the IRS yearly-average table only for the consolidated sheet.
-- bank_key matches the engine's per-bank grouping key ("<bank_name> <account_type>").

CREATE TABLE IF NOT EXISTS account_bank_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  tax_year integer NOT NULL,
  bank_key text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  opening_balance numeric,
  closing_balance numeric,
  source text NOT NULL DEFAULT 'client' CHECK (source IN ('client','staff')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, tax_year, bank_key)
);

ALTER TABLE account_bank_balances ENABLE ROW LEVEL SECURITY;
