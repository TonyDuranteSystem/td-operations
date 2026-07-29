-- TD BOOKS — Phase 1a step 2: retire the owner slice of the multi-tenant table.
--
-- Run ONLY after 20260729-1500 (create+copy) AND after the "every number identical" gate
-- passed against td_books_transactions. Copy-verify-retire, in that order.
--
-- The bookkeeper review items point at book rows by id. Ids were PRESERVED in the copy,
-- so the foreign key is re-pointed to the new table first — otherwise the delete below is
-- rejected for any reviewed row (the FK's default NO ACTION), and after a naive repoint
-- the references would still be valid because the ids are identical.
--
-- The delete is scoped by BOTH the owner sentinel AND presence in the new table: a row
-- that somehow failed to copy is NOT deleted (fail toward keeping data twice, never
-- toward losing it). Client rows are untouched by construction.

ALTER TABLE bookkeeper_review_items
  DROP CONSTRAINT IF EXISTS bookkeeper_review_items_tx_id_fkey;

ALTER TABLE bookkeeper_review_items
  ADD CONSTRAINT bookkeeper_review_items_tx_id_fkey
  FOREIGN KEY (tx_id) REFERENCES td_books_transactions(id);

DELETE FROM bank_transactions b
WHERE b.account_id = '00000000-0000-0000-0000-000000000001'
  AND EXISTS (SELECT 1 FROM td_books_transactions t WHERE t.id = b.id);
