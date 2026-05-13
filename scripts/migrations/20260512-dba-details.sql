-- Account fields Phase 1, Part 2: dba_details table
-- Plan: ops-2026-05-12-account-fields-plan
--
-- Per-SD detail rows for DBA (Doing Business As) registrations. One DBA can
-- result in one or more dba_details rows when a client registers the same
-- trade name in multiple jurisdictions (rare but supported). delivery_id
-- references service_deliveries(id) and is REQUIRED — a DBA detail row
-- without a parent SD is meaningless.
--
-- Phase 1 scope:
--   - Table only (no triggers, no views, no RLS policies yet).
--   - delivery_id is a hard FK (no cascade) — deleting an SD must explicitly
--     handle dba_details first. We will revisit ON DELETE behavior in Phase 2
--     once we know whether SD soft-delete is the standard.
--
-- Apply to SANDBOX first:
--   node scripts/apply-migration.js scripts/migrations/20260512-dba-details.sql

CREATE TABLE IF NOT EXISTS dba_details (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id         UUID NOT NULL REFERENCES service_deliveries(id),
  dba_name            TEXT NOT NULL,
  jurisdiction        TEXT NOT NULL,
  filed_date          DATE,
  registration_number TEXT,
  renewal_date        DATE,
  renewal_period      TEXT,
  filing_fee          NUMERIC,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dba_details_delivery_id
  ON dba_details (delivery_id);
