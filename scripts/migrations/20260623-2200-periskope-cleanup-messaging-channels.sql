-- Migration: 20260623-2200-periskope-cleanup-messaging-channels
-- Remove Periskope from messaging_channels.
-- Sets provider = NULL (pending connection) on any row using Periskope.
-- Also drops the NOT NULL constraint on provider so the table can represent
-- "no provider configured yet" without a dummy string.
--
-- Sandbox: run via   node scripts/apply-migration.js scripts/migrations/20260623-2200-periskope-cleanup-messaging-channels.sql
-- Production: after sandbox QA, apply via execute_sql with reason "migration:20260623-2200-periskope-cleanup-messaging-channels.sql"

BEGIN;

-- Step 1: Allow provider to be NULL (represents "not connected / pending")
ALTER TABLE messaging_channels ALTER COLUMN provider DROP NOT NULL;

-- Step 2: Clear any row whose provider is 'periskope' (case-insensitive)
--         and scrub any periskope-related keys from config_json
UPDATE messaging_channels
SET
  provider = NULL,
  config_json = CASE
    WHEN config_json IS NOT NULL
    THEN config_json - 'provider' - 'periskope'
    ELSE NULL
  END
WHERE lower(provider) = 'periskope'
   OR (config_json IS NOT NULL AND config_json::text ILIKE '%periskope%');

COMMIT;
