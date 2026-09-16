-- Tracks which hand-entered td_books_transactions row has already been matched away as a
-- duplicate of a synced Plaid transaction — so a later sync (a different cron tick, a webhook
-- push, a manual button click) can never match the SAME manual row a second time.
--
-- Deliberately a separate, out-of-band table rather than a column on td_books_transactions
-- itself: books rows are insert-once and never updated once a row exists (see the header
-- comment above sweepFeedsToOwnerLedger in lib/finance/owner-ledger-projection.ts) — a books
-- row Antonio has already reviewed/categorized must never be touched by an automated process.
--
-- One manual row can be consumed at most once, ever (the unique constraint) — this is what
-- makes the "already matched, don't match again" check race-safe: two concurrent syncs
-- attempting to consume the same manual row will have exactly one insert succeed.
CREATE TABLE IF NOT EXISTS plaid_match_consumption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manual_transaction_id uuid NOT NULL REFERENCES td_books_transactions(id) ON DELETE CASCADE,
  plaid_transaction_id text NOT NULL,
  matched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manual_transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_plaid_match_consumption_manual_transaction_id
  ON plaid_match_consumption(manual_transaction_id);
