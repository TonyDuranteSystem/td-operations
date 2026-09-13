-- Corrects the previous migration (20260913-2030): a PARTIAL unique index
-- (WHERE external_id IS NOT NULL) cannot be targeted by a bare
-- `ON CONFLICT (external_id)` clause with no matching WHERE predicate —
-- Postgres can't infer which constraint to use, and the real upsert this
-- exists for (sendOwnerTransactionToFinance) failed live with "no unique or
-- exclusion constraint matching the ON CONFLICT specification" even after
-- the partial index was in place.
--
-- Fix: a PLAIN (non-partial) unique index. This works for the existing data
-- with no special-casing: standard SQL/Postgres never treats two NULLs as
-- equal for uniqueness purposes, so the 2 existing NULL-external_id rows
-- (confirmed live) do not conflict with each other or need excluding —
-- the earlier WHERE clause was unnecessary, not just insufficient.
DROP INDEX IF EXISTS uq_td_bank_feeds_external_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_td_bank_feeds_external_id
  ON td_bank_feeds (external_id);
