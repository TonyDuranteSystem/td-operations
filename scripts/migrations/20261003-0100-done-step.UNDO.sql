-- UNDO for 20261003-0100-done-step.sql. The code falls back to the old name rule when the column is gone.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS trg_pipeline_stage_done_default ON public.pipeline_stages;
DROP FUNCTION IF EXISTS public.trg_pipeline_stage_done_default();
ALTER TABLE public.pipeline_stages DROP COLUMN IF EXISTS completes_service;
COMMIT;
