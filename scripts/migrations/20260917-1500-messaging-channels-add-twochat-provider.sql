-- Migration: 20260917-1500-messaging-channels-add-twochat-provider
-- Allow 'twochat' as a valid messaging_channels.provider value, for the
-- 2Chat.co WhatsApp integration (dev job f331cd43-3352-4539-b276-3dbe7158c37c).
--
-- Sandbox: run via   node scripts/apply-migration.js scripts/migrations/20260917-1500-messaging-channels-add-twochat-provider.sql
-- Production: after sandbox QA, apply via execute_sql with reason "migration:20260917-1500-messaging-channels-add-twochat-provider.sql"

BEGIN;

ALTER TABLE messaging_channels DROP CONSTRAINT messaging_channels_provider_check;

ALTER TABLE messaging_channels ADD CONSTRAINT messaging_channels_provider_check
  CHECK (provider = ANY (ARRAY['wassenger'::text, 'telegram_bot_api'::text, 'meta'::text, 'twilio'::text, 'twochat'::text]));

COMMIT;
