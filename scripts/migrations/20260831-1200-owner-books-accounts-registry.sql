-- Owner books: the ACCOUNT REGISTRY.
--
-- WHY THIS EXISTS. Everything the system knows about Antonio's accounts currently
-- lives in a session's head and in two one-off scripts: that Amex writes charges
-- backwards, that the First Citizens loan does too, that Stripe is a clearing
-- account and not a bank, that a card balance is a debt and must never be added
-- into cash. None of it is written down anywhere the code can read.
--
-- The proof that this is a real gap, not a tidiness concern: the Amex sign
-- inversion was repaired across 809 rows on 2026-08-31 as DATA. Upload a January
-- 2026 Amex file tomorrow and it lands inverted again, because nothing records the
-- convention. The repair has to become a fact about the account.
--
-- This table is also the first half of the "smart system" Antonio asked for. An
-- agent cannot reason about books whose accounts it cannot describe.

CREATE TABLE IF NOT EXISTS td_books_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id         UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',

  -- The label the transactions carry. This is the join key to
  -- td_books_transactions.bank_name, so it must match EXACTLY.
  bank_name         TEXT NOT NULL,
  institution       TEXT,
  account_number    TEXT,

  -- Drives the ACCOUNTING, not just display: a card and a loan are liabilities,
  -- so their balances are money owed and can never be summed into cash.
  account_type      TEXT NOT NULL
                      CHECK (account_type IN ('checking','savings','credit_card','loan','processor')),

  -- 'normal'   = negative means money left the business (Chase, Mercury, Relay…)
  -- 'inverted' = the export writes a charge POSITIVE and a payment NEGATIVE (Amex),
  --              or a drawdown as money out (the First Citizens loan).
  -- The importer reads this instead of copying whatever the file happens to say.
  sign_convention   TEXT NOT NULL DEFAULT 'normal'
                      CHECK (sign_convention IN ('normal','inverted')),

  -- A clearing account holds money in transit and is NOT a bank. Stripe's balance
  -- ties to Stripe's own report, never to a bank statement, and its payouts are
  -- transfers rather than income — the distinction that prevents a six-figure
  -- double-count.
  is_clearing       BOOLEAN NOT NULL DEFAULT FALSE,

  currency          TEXT NOT NULL DEFAULT 'USD',

  -- Balances, with their PROVENANCE. A figure derived from the transaction rows is
  -- not the same kind of fact as one read off the institution's own statement, and
  -- a balance sheet must be able to tell them apart.
  opening_balance   NUMERIC,
  opening_date      DATE,
  closing_balance   NUMERIC,
  closing_date      DATE,
  closing_source    TEXT CHECK (closing_source IN ('statement','derived','provider_report','unknown')),

  -- Free text for what a future reader must not have to rediscover.
  notes             TEXT,

  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (entity_id, bank_name)
);

CREATE INDEX IF NOT EXISTS idx_td_books_accounts_entity ON td_books_accounts (entity_id, is_active);

COMMENT ON TABLE td_books_accounts IS
  'What the system knows about each of the owner''s accounts: its type, its sign convention, whether it is a clearing account, and its balances with provenance. Written because an Amex sign inversion repaired as data would silently return on the next import.';
