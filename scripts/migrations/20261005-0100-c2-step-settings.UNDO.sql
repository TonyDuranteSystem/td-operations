-- UNDO for 20261005-0100-c2-step-settings.sql. Restores the 20261003-0100 done-default trigger body.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"c2-migration-undo"}', true);
DROP TRIGGER IF EXISTS trg_delivery_document_to_advance ON public.service_deliveries;
DROP FUNCTION IF EXISTS public.trg_delivery_document_to_advance();
DROP INDEX IF EXISTS public.pipeline_stages_one_done_per_service;
ALTER TABLE public.pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_waiting_on_check;
ALTER TABLE public.pipeline_stages DROP COLUMN IF EXISTS requires_document_to_advance;
ALTER TABLE public.pipeline_stages DROP COLUMN IF EXISTS waiting_on;
CREATE OR REPLACE FUNCTION public.trg_pipeline_stage_done_default() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT COALESCE(NEW.completes_service, false)
     AND (NEW.stage_name IN ('Completed', 'TR Filed')
          OR (NEW.stage_name = 'Closed' AND NEW.service_type IN ('State RA Renewal', 'State Annual Report'))) THEN
    NEW.completes_service := true;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
