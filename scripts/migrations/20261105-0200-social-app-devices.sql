-- TD Social (iPhone app), Step 2 / pull request A (dev job 2072bc3e): the list of registered phones.
-- SANDBOX first (R105). UNDO: 20261105-0200-social-app-devices.UNDO.sql
--
-- One row per phone (bundle id + Apple alert token). The row says WHO the phone belongs to; the server (never the phone) decides
-- what that person may see. RLS on, no policies: only the service role, behind routes that check the signed-in person, can reach it
-- (same pattern as storage_app_devices). Anon and signed-in browser tokens get nothing.
--
-- DESIGN RULES (Council review, 5 Nov 2026):
--   * NO CHECK value lists (a new list on the shared sandbox turned every session's CI red once): the token shape, the bundle id and
--     the two-value `apns_env` are validated in code (lib/app/devices.ts).
--   * `apns_env` holds a two-value setting ('development' | 'production'), NEVER an address: the server owns the two Apple addresses.
--   * One row per (bundle_id, token). Registering the same token again moves it to the signed-in person in ONE statement
--     (INSERT .. ON CONFLICT DO UPDATE) and clears any revoked mark.
--   * Nothing reads this table until the on/off setting `social_app_enabled` is true (code: lib/app/enabled.ts), so merging the
--     code before this file reaches production is safe.

CREATE TABLE IF NOT EXISTS public.social_app_devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  token          text NOT NULL,
  bundle_id      text NOT NULL,
  apns_env       text NOT NULL,
  device_name    text,
  app_version    text,
  app_build      integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoked_reason text,
  CONSTRAINT social_app_devices_bundle_token_key UNIQUE (bundle_id, token)
);

CREATE INDEX IF NOT EXISTS social_app_devices_user_idx ON public.social_app_devices (user_id) WHERE revoked_at IS NULL;

ALTER TABLE public.social_app_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_app_devices FROM anon, authenticated;
