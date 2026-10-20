-- Undo of 20261020-1900-s3-service-start-notices.sql. Removes the opt-in flag and the service_started message row.
-- Safe at any time: with the go-live switch unset (or after this runs) no S3 line or message is produced.
-- Notifications/chat messages already sent stay (they are history); nothing else depends on the column.
BEGIN;
SET LOCAL lock_timeout = '5s';
DELETE FROM public.catalog_entries WHERE catalog_id = 'welcome_messages' AND slug = 'service_started';
ALTER TABLE public.pipeline_stages DROP COLUMN IF EXISTS client_task_in_list;
COMMIT;
