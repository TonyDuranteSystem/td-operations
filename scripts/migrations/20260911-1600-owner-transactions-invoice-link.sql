-- Lets a My Finances transaction be explicitly linked to a client invoice
-- (Antonio: "click the transaction, link it to an invoice, write a note").
--
-- Deliberately additive, never destructive: the source row in
-- td_books_transactions is annotated, not deleted or recategorized. This
-- avoids three real risks found in council review before this shipped:
--   1. Deleting it can silently understate a bank account's displayed cash
--      balance if this was the latest dated row carrying a real balance_after.
--   2. Deleting it makes the row invisible to the statement-upload duplicate
--      check, so a later re-upload covering the same date could silently
--      re-add the same money as if it were new.
--   3. Deleting it throws away any categorization/notes/tax-year linkage
--      already on the row.
-- Recording the link on the row itself (not routing through td_bank_feeds)
-- also avoids the automatic "maybe a client payment" sweep re-claiming an
-- ambiguous transaction before a human match ever happens, and avoids the
-- signed/unsigned amount conversion that direction would otherwise need.

-- Revised same-day (Antonio: the actual pick-invoice/note/write-off popup
-- belongs in Finance, not in My Finances — My Finances only ever gets a
-- simple "send this to Finance" action). moved_to_feed_id records that a
-- transaction has been sent over, pointing at the resulting td_bank_feeds
-- row; linked_payment_id/linked_at/linked_note/linked_by are filled in
-- later, once that Finance-side row is actually matched to an invoice, kept
-- here (not only on td_bank_feeds) so My Finances shows the outcome without
-- a second query.
ALTER TABLE td_books_transactions
  ADD COLUMN IF NOT EXISTS moved_to_feed_id uuid REFERENCES td_bank_feeds(id),
  ADD COLUMN IF NOT EXISTS linked_payment_id uuid REFERENCES payments(id),
  ADD COLUMN IF NOT EXISTS linked_at timestamptz,
  ADD COLUMN IF NOT EXISTS linked_note text,
  ADD COLUMN IF NOT EXISTS linked_by text;

CREATE INDEX IF NOT EXISTS idx_td_books_tx_moved_to_feed
  ON td_books_transactions (moved_to_feed_id)
  WHERE moved_to_feed_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_td_books_tx_linked_payment
  ON td_books_transactions (linked_payment_id)
  WHERE linked_payment_id IS NOT NULL;
