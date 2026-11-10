-- UNDO for 20261110-0100-client-app-phone-owner.sql (client app phone owner fields). Phones keep working; they just stop being found by contact or company.
DROP INDEX IF EXISTS public.social_app_devices_contact_idx;
DROP INDEX IF EXISTS public.social_app_devices_team_account_idx;
ALTER TABLE public.social_app_devices DROP COLUMN IF EXISTS contact_id;
ALTER TABLE public.social_app_devices DROP COLUMN IF EXISTS team_account_id;
