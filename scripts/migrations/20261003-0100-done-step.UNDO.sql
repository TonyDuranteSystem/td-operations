-- UNDO for 20261003-0100-done-step.sql. The code falls back to the old name rule when the column is gone.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.pipeline_stages DROP COLUMN IF EXISTS completes_service;
COMMIT;
