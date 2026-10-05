-- UNDO for 20261005-0200-c2-step-lists.sql: restores the DBA and EIN step lists as they were on 2026-10-04.
-- Refuses if any DBA job exists or any active EIN job exists (same guards as the forward migration).
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"c2-migration-undo"}', true);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.service_deliveries WHERE service_type = 'DBA') THEN
    RAISE EXCEPTION 'c2 undo: DBA jobs exist';
  END IF;
  IF EXISTS (SELECT 1 FROM public.service_deliveries WHERE service_type = 'EIN' AND status NOT IN ('completed', 'cancelled')) THEN
    RAISE EXCEPTION 'c2 undo: active EIN jobs exist';
  END IF;
END $$;
DELETE FROM public.pipeline_stages WHERE service_type = 'DBA';
INSERT INTO public.pipeline_stages (service_type, stage_order, stage_name, auto_advance) VALUES
  ('DBA', 1, 'Data Collection', true), ('DBA', 2, 'Application Preparation', true), ('DBA', 3, 'Publication', true),
  ('DBA', 4, 'Filed with State', true), ('DBA', 5, 'Registered', true), ('DBA', 6, 'Renewal Due', true);
DELETE FROM public.pipeline_stages WHERE service_type = 'EIN' AND stage_name IN ('SS-4 Prepared', 'SS-4 Signed');
UPDATE public.pipeline_stages SET stage_order = stage_order + 100000 WHERE service_type = 'EIN';
UPDATE public.pipeline_stages SET stage_order = CASE stage_name
    WHEN 'SS-4 Preparation' THEN 1 WHEN 'SS-4 Submitted' THEN 2 WHEN 'Awaiting EIN' THEN 3 WHEN 'EIN Received' THEN 4 END
 WHERE service_type = 'EIN';
UPDATE public.service_deliveries sd SET stage_order = ps.stage_order
  FROM public.pipeline_stages ps
 WHERE sd.service_type = 'EIN' AND ps.service_type = 'EIN' AND ps.stage_name = sd.stage
   AND sd.stage_order IS DISTINCT FROM ps.stage_order;
COMMIT;
