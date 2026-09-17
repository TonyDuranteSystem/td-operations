-- Migration: 20260917-1600-messages-external-message-id-unique
-- Add a unique constraint on messages.external_message_id so a webhook retry
-- (redelivering the same inbound message) is rejected at the DB level, not
-- relied on at the application layer alone. Postgres treats NULLs as
-- distinct from each other, so older rows with no external id are unaffected.
-- Verified against production before writing this migration: zero existing
-- duplicate non-null values.
--
-- Sandbox: run via   node scripts/apply-migration.js scripts/migrations/20260917-1600-messages-external-message-id-unique.sql
-- Production: after sandbox QA, apply via execute_sql with reason "migration:20260917-1600-messages-external-message-id-unique.sql"

BEGIN;

ALTER TABLE messages ADD CONSTRAINT messages_external_message_id_key UNIQUE (external_message_id);

COMMIT;
