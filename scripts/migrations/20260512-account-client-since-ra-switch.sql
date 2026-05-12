-- Account fields Phase 1, Part 1: client_since + ra_switch_date
-- Plan: ops-2026-05-12-account-fields-plan
--
-- Adds two nullable DATE columns to accounts:
--   client_since      — when the account became a paying TD client. Backfill
--                       is deferred (Phase 2 / manual ops review).
--   ra_switch_date    — when TD became Registered Agent for this LLC. Used to
--                       compute first-year-of-service RA renewal billing and
--                       on-account-detail "RA since YYYY" display.
--
-- Both columns are nullable — historic rows stay NULL until manually filled.
-- No DEFAULT, no backfill in this migration.
--
-- Apply to SANDBOX first:
--   node scripts/apply-migration.js scripts/migrations/20260512-account-client-since-ra-switch.sql
-- Promote to production (after sandbox QA):
--   execute_sql(mode:"write", reason:"migration:20260512-account-client-since-ra-switch.sql", query:"<contents>")

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS client_since DATE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ra_switch_date DATE;
