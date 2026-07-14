-- Stop "delete duplicate transaction" from silently destroying the double-credit guard.
--
-- WHY (2026-07-14, caught in review after the ledger shipped):
-- `payment_applications` records that a given bank transaction has been applied to a given
-- invoice. That record is what stops the SAME transaction being credited to the SAME
-- invoice twice on a later run — the CAS on the invoice only guards concurrent writes; the
-- ledger row is the idempotency key over TIME.
--
-- Both foreign keys were created ON DELETE CASCADE. And Finance has a "Delete Plaid
-- duplicate" button that deletes a bank-feed row outright.
--
-- So: delete a feed → its ledger row is silently cascade-deleted → but the money it applied
-- is STILL sitting on the invoice. The idempotency record is gone while the effect remains.
-- A later re-sync of the same transaction would then be free to credit that invoice a
-- second time, with no evidence that it had ever been applied.
--
-- Harmless the day it shipped (the ledger was empty), which is exactly why it had to be
-- fixed before it wasn't.
--
-- RESTRICT instead: a feed that has actually moved money cannot be deleted. If someone
-- genuinely needs to remove such a row, they must first unmatch it — a deliberate act that
-- goes through the money path, rather than a side effect of a cleanup button.
--
-- The payment_id FK keeps CASCADE: deleting an invoice legitimately removes its application
-- records, and invoice deletion is not a routine operation.

ALTER TABLE payment_applications
  DROP CONSTRAINT IF EXISTS payment_applications_feed_id_fkey;

ALTER TABLE payment_applications
  ADD CONSTRAINT payment_applications_feed_id_fkey
  FOREIGN KEY (feed_id) REFERENCES td_bank_feeds(id) ON DELETE RESTRICT;

COMMENT ON CONSTRAINT payment_applications_feed_id_fkey ON payment_applications IS
  'RESTRICT, deliberately. A bank transaction that has applied money to an invoice cannot be deleted — cascading it away would destroy the idempotency record while leaving the money on the invoice, allowing the same transaction to be credited again later.';
