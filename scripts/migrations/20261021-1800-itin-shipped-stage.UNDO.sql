-- UNDO of 20261021-1800-itin-shipped-stage.sql. Refuses if any ITIN case sits on 'Shipped' (move it first).
BEGIN;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_deliveries WHERE service_type = 'ITIN' AND stage = 'Shipped') THEN
    RAISE EXCEPTION 'itin-shipped-stage UNDO: % ITIN case(s) are on Shipped — nothing changed', (SELECT count(*) FROM public.service_deliveries WHERE service_type = 'ITIN' AND stage = 'Shipped');
  END IF;
END
$do$;
UPDATE public.catalog_entries
   SET metadata = jsonb_set(metadata, '{workflow_chain,transitions,itin_await_client_mailing,client_mailed,advance_sd_stage}', '"Documents Received"'::jsonb, false), updated_at = now()
 WHERE catalog_id = 'services' AND slug = 'itin';
UPDATE public.service_deliveries SET stage_order = stage_order - 1 WHERE service_type = 'ITIN' AND stage_order >= 5;
UPDATE public.tasks SET stage_order = stage_order - 1 WHERE stage_order >= 5 AND delivery_id IN (SELECT id FROM public.service_deliveries WHERE service_type = 'ITIN');
DELETE FROM public.pipeline_stages WHERE service_type = 'ITIN' AND stage_name = 'Shipped';
UPDATE public.pipeline_stages SET stage_order = stage_order + 1000 WHERE service_type = 'ITIN' AND stage_order >= 5;
UPDATE public.pipeline_stages SET stage_order = stage_order - 1001 WHERE service_type = 'ITIN' AND stage_order >= 1005;
COMMIT;
