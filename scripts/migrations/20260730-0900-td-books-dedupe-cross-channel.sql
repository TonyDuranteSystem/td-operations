-- TD BOOKS — remove cross-channel duplicate rows (Mercury is synced via BOTH its native
-- API and Plaid; the same transaction arrived once per channel and both copies were
-- swept into the books before the origin-aware coverage guard existed).
--
-- DML, not DDL. Run AFTER the code carrying the guard is live (or at the same ship).
-- Keeps the Plaid ('mercury') copy — it carries the richer counterparty wording —
-- deletes the native ('mercury_api') twin and marks its feed row 'duplicate' so the
-- tie-out and the Bank Feed agree it is the same money. Verified on sandbox 2026-07-30:
-- 6 pairs removed, 0 remaining, no client rows involved.

WITH books_feed AS (
  SELECT b.id AS book_id, b.transaction_date, b.amount, b.bank_name, f.source, f.id AS feed_id
  FROM td_books_transactions b
  JOIN td_bank_feeds f ON f.id::text = replace(b.transaction_ref, 'feed:', '')
  WHERE b.transaction_ref LIKE 'feed:%'
),
pairs AS (
  SELECT a.book_id AS keep_book, b.book_id AS drop_book, b.feed_id AS drop_feed
  FROM books_feed a
  JOIN books_feed b
    ON a.transaction_date = b.transaction_date AND a.amount = b.amount
   AND a.bank_name = b.bank_name AND a.source <> b.source
   AND a.source = 'mercury' AND b.source = 'mercury_api'
),
del AS (
  DELETE FROM td_books_transactions WHERE id IN (SELECT drop_book FROM pairs) RETURNING id
),
mark AS (
  UPDATE td_bank_feeds SET status = 'duplicate' WHERE id IN (SELECT drop_feed FROM pairs) RETURNING id
)
SELECT (SELECT count(*) FROM del) AS books_copies_removed,
       (SELECT count(*) FROM mark) AS feeds_marked_duplicate;
