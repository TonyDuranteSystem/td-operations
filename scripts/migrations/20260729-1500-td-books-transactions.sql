-- TD BOOKS — Phase 1a: the company's books get their OWN table.
--
-- Until now the owner's books lived as a slice of the multi-tenant `bank_transactions`
-- table (every client's tax data + the owner's rows, separated only by a sentinel
-- account UUID) — named by three council reviews as the single biggest corruption risk
-- in the books plan, and impossible to evolve independently (books need columns and
-- CHECKs client tax data must not carry).
--
-- `entity_id` exists from day one (Antonio's multi-entity flexibility ask, 2026-07-29):
-- today only Tony Durante LLC ('00000000-0000-0000-0000-000000000001'), but a second
-- company's books are an INSERT away, not a schema migration away.
--
-- Identity/dedup: UNIQUE (entity_id, transaction_ref). Deliberately NOT the 4-column
-- key the old shared table uses — the architect's review showed date+amount in the key
-- turns an upstream amount correction into a DUPLICATE row instead of a conflict. Here
-- the ref alone is identity; date/amount are payload. (Verified before choosing this:
-- the owner slice has zero duplicate refs.)
--
-- Category CHECK includes 'contribution' (the client vocabulary has it; the owner UI's
-- category list lacked it, and the S-corp equity roll-forward needs it).
--
-- This migration COPIES the owner rows (preserving ids, so any future FK re-pointing
-- stays trivial) and DELETES NOTHING. Retirement of the old slice is a separate
-- migration, run only after the "every number identical" gate passes.

CREATE TABLE IF NOT EXISTS td_books_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id        uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  tax_year         integer NOT NULL,
  transaction_date date NOT NULL,
  description      text,
  counterparty     text,
  amount           numeric NOT NULL,
  currency         text NOT NULL DEFAULT 'USD',
  balance_after    numeric,
  bank_name        text,
  account_type     text,
  transaction_ref  text NOT NULL CHECK (btrim(transaction_ref) <> ''),
  category         text NOT NULL DEFAULT 'uncategorized'
    CONSTRAINT td_books_transactions_category_check CHECK (category = ANY (ARRAY[
      'income'::text, 'cogs'::text, 'expense'::text, 'distribution'::text,
      'contribution'::text, 'fee'::text, 'conversion'::text, 'refund'::text,
      'uncategorized'::text
    ])),
  subcategory      text,
  is_related_party boolean NOT NULL DEFAULT false,
  notes            text,
  source_file_id   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_td_books_tx_entity_ref
  ON td_books_transactions (entity_id, transaction_ref);

CREATE INDEX IF NOT EXISTS idx_td_books_tx_entity_year
  ON td_books_transactions (entity_id, tax_year);

CREATE INDEX IF NOT EXISTS idx_td_books_tx_entity_date
  ON td_books_transactions (entity_id, transaction_date DESC);

-- Copy the owner slice, ids preserved. Idempotent: a re-run inserts nothing new.
INSERT INTO td_books_transactions (
  id, entity_id, tax_year, transaction_date, description, counterparty, amount,
  currency, balance_after, bank_name, account_type, transaction_ref, category,
  subcategory, is_related_party, notes, source_file_id, created_at
)
SELECT
  id, account_id, tax_year, transaction_date, description, counterparty, amount,
  COALESCE(currency, 'USD'), balance_after, bank_name, account_type, transaction_ref,
  COALESCE(category, 'uncategorized'), subcategory, COALESCE(is_related_party, false),
  notes, source_file_id, COALESCE(created_at, now())
FROM bank_transactions
WHERE account_id = '00000000-0000-0000-0000-000000000001'
ON CONFLICT (entity_id, transaction_ref) DO NOTHING;
