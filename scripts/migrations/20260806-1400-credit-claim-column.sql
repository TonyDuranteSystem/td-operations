-- WS-A credit engine (dev job c0a61e44): the DEDICATED claim column.
--
-- WHY NOT reuse credit_for_payment_id: that column is DUAL-PURPOSED — manual
-- credit notes are BORN with it set to the SOURCE invoice they were issued
-- against (invoice-actions.ts), and consumeCredits later overwrites it with the
-- offset invoice. A conditional claim on "IS NULL" would therefore refuse to
-- consume any source-linked credit note, forever. This column has exactly one
-- meaning: "this credit is claimed by that invoice".
--
-- WHAT ENFORCES SINGLE-CLAIM (stated precisely — there is no index trick here):
-- the atomic conditional UPDATE
--     UPDATE payments SET credit_consumed_by = :invoiceId
--      WHERE id = :creditId AND credit_consumed_by IS NULL
-- Postgres takes a row lock; of two concurrent claimers exactly one reports
-- rowcount 1 and the other reports 0. The loser does not consume. A partial
-- unique index would add NOTHING here (a unique index on the primary key is
-- already implied, and the constraint we need is per-ROW state, not
-- cross-row uniqueness) — so none is created, deliberately.
--
-- Two concurrent readers DO both see the same available credit (pinned by test
-- T9): that is exactly why the guard lives in this write and not in the read.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS credit_consumed_by uuid;

COMMENT ON COLUMN payments.credit_consumed_by IS
  'WS-A credit claim: the invoice id that atomically claimed this credit note. NULL = unclaimed/available. Distinct from credit_for_payment_id (dual-purposed: source invoice at issuance, then last offset). Claimed under a conditional UPDATE (rowcount-checked) BEFORE the offsetting invoice is created; unwound if that creation fails.';
