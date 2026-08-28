-- dev job c3efa6cb: banking_submissions had zero uniqueness protection beyond
-- its primary key, so the same account+provider pair could get two rows —
-- confirmed a real risk (double-submit / resubmission race) during the
-- council review of the What's New banking-notification fix. Verified no
-- existing duplicates before adding this (see dev job progress log).
--
-- A partial unique index (not a plain UNIQUE constraint) so soft-deleted or
-- superseded rows, if that pattern is ever added later, don't collide with
-- a live row — matches the existing partial-unique-index pattern already
-- used elsewhere in this schema (uq_payments_invoice_number).
CREATE UNIQUE INDEX IF NOT EXISTS uq_banking_submissions_account_provider
  ON banking_submissions (account_id, provider);
