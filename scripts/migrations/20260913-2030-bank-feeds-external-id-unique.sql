-- td_bank_feeds.external_id was never actually unique in the live database —
-- discovered 2026-09-13 when sendOwnerTransactionToFinance's own upsert
-- (ON CONFLICT (external_id)) failed live with "no unique or exclusion
-- constraint matching the ON CONFLICT specification". A direct probe insert
-- confirmed it: two rows with the identical external_id both succeeded with
-- no error. This means the idempotency this column was always meant to
-- provide (a retried sync, or a retried "send to Finance" click, can never
-- create two feed rows for the same source transaction) was never actually
-- enforced by the database — only assumed.
--
-- Partial (WHERE external_id IS NOT NULL), not a plain UNIQUE constraint:
-- confirmed live that 2 existing rows carry a NULL external_id (manually
-- entered feeds that predate this column's use) — a plain UNIQUE constraint
-- treats those as non-conflicting anyway under standard Postgres NULL
-- semantics, but a partial index says so explicitly and matches this
-- codebase's own established convention for optional-uniqueness columns.
--
-- Checked directly against live sandbox data first: 497 non-null external_id
-- rows, zero duplicates — safe to add without a backfill/dedupe step.
CREATE UNIQUE INDEX IF NOT EXISTS uq_td_bank_feeds_external_id
  ON td_bank_feeds (external_id)
  WHERE external_id IS NOT NULL;
