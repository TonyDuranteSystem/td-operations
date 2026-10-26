-- TD Storage Mac app (dev job 1992a087): each signed-in Mac reports which app version it runs, so the CRM can show who has updated.
-- Additive and nullable: nothing existing changes; older apps simply leave them empty. The code tolerates the columns being absent (fail-soft), so this
-- may be run before OR after the code that uses it.
ALTER TABLE storage_app_devices ADD COLUMN IF NOT EXISTS app_version text;
ALTER TABLE storage_app_devices ADD COLUMN IF NOT EXISTS app_build integer;
