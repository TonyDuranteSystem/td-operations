-- Migration: 20260624-1500-periskope-full-purge-messaging-channels
-- FULLY removes "periskope" from messaging_channels (supersedes the partial
-- 20260623-2200 cleanup). Periskope is dead; this purges every trace:
--   1. provider column value 'periskope'        -> NULL (pending / not connected)
--   2. config_json 'provider'/'periskope' keys   -> removed
--   3. config_json.description "...da collegare su Periskope" -> stripped
--   4. the provider CHECK constraint that lists 'periskope' -> replaced with the
--      actually-supported providers (wassenger, telegram_bot_api, meta, twilio);
--      NULL is allowed (a CHECK passes on NULL). This also UNBLOCKS the meta/twilio
--      providers the flexible send-dispatcher (PR #118) was built for.
--
-- Telegram channel (provider='telegram_bot_api') is untouched.
--
-- Sandbox: node scripts/apply-migration.js scripts/migrations/20260624-1500-periskope-full-purge-messaging-channels.sql
-- Production: apply the same SQL once approved (DDL — via the sanctioned migration path).

BEGIN;

-- 1. allow NULL provider (= "not connected yet")
ALTER TABLE public.messaging_channels ALTER COLUMN provider DROP NOT NULL;

-- 2. clear periskope from the rows FIRST (before swapping the CHECK): provider ->
--    NULL, scrub config_json keys + description text. NULL passes the existing CHECK.
UPDATE public.messaging_channels
SET
  provider = NULL,
  config_json = CASE
    WHEN config_json IS NOT NULL THEN
      jsonb_set(
        (config_json - 'provider' - 'periskope'),
        '{description}',
        to_jsonb(
          NULLIF(
            btrim(
              regexp_replace(
                coalesce(config_json->>'description', ''),
                '[,;:-]?\s*da collegare su periskope',
                '', 'gi'
              ),
              ' ,;:-'
            ),
            ''
          )
        ),
        false
      )
    ELSE NULL
  END
WHERE lower(provider) = 'periskope'
   OR (config_json IS NOT NULL AND config_json::text ILIKE '%periskope%');

-- 3. now that no row holds 'periskope', replace the provider CHECK: drop 'periskope',
--    allow the supported set + NULL (also unblocks meta/twilio for the dispatcher).
ALTER TABLE public.messaging_channels DROP CONSTRAINT IF EXISTS messaging_channels_provider_check;
ALTER TABLE public.messaging_channels ADD CONSTRAINT messaging_channels_provider_check
  CHECK (provider = ANY (ARRAY['wassenger'::text, 'telegram_bot_api'::text, 'meta'::text, 'twilio'::text]));

COMMIT;
