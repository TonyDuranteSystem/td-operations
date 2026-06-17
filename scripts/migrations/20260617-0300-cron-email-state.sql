-- cron_email_state — durable per-cron "last emailed" snapshot, so noisy crons
-- only email when something actually changed (and at most once / 24h).
--
-- Canonical schema MIRRORS the production table (created manually 2026-06-17):
--   id              uuid PK default gen_random_uuid()
--   cron_name       text NOT NULL UNIQUE   (upsert conflict target)
--   last_payload    jsonb                  (the set of findings last emailed)
--   last_emailed_at timestamptz            (drives the 24h throttle)
--
-- DROP+CREATE realigns SANDBOX, whose first cut of this table used a different
-- shape (key/snapshot). The table is empty in every environment, so this is a
-- no-data-loss reset. PRODUCTION already exists in exactly this shape and this
-- migration is NOT re-applied there (the DDL guard blocks prod DDL anyway).
--
-- First consumer: /api/cron/audit-health-check (cron_name='audit-health-check').

DROP TABLE IF EXISTS cron_email_state;

CREATE TABLE cron_email_state (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_name       text NOT NULL UNIQUE,
  last_payload    jsonb,
  last_emailed_at timestamptz
);
