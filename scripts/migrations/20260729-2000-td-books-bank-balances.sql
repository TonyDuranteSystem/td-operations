-- TD BOOKS — Phase 2: per-bank statement balances for the tie-out.
--
-- Books are TRUSTWORTHY when they tie to what the bank statements say. This table holds
-- the statement-stated opening/closing balance per (bank, currency, year); the tie-out
-- compares closing vs opening + the movement the system actually captured (owner books
-- rows PLUS client-payment deposits from the bank feed — client money is real bank
-- movement even though its income lives in the payments ledger, not the books).
-- Mirrors the client-side account_bank_balances shape, entity-keyed like the books.

CREATE TABLE IF NOT EXISTS td_books_bank_balances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id       uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  tax_year        integer NOT NULL,
  bank_key        text NOT NULL CHECK (btrim(bank_key) <> ''),
  currency        text NOT NULL DEFAULT 'USD',
  opening_balance numeric,
  closing_balance numeric,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_td_books_balances
  ON td_books_bank_balances (entity_id, tax_year, bank_key, currency);
