-- UNDO of 20261019-1000-change-name-8-steps.sql — restores the 5 old Company Change Name steps, the jobs' old step names and
-- numbers, the cancelled workflow cards and the workflow's old status from public.zz_change_name_8_steps_backup, then drops it.
-- REFUSES unless every name-change job still sits on step 1 or 2 (only those two map back to an old step without losing where the job is),
-- and unless the backup exists.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"change-name-8-steps-undo"}', true);

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.zz_change_name_8_steps_backup WHERE kind = 'pipeline_stages') THEN
    RAISE EXCEPTION 'change-name-8-steps UNDO: no backup found — nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.service_deliveries
              WHERE service_type = 'Company Change Name' AND stage NOT IN ('Collect three company names', 'Check names and client confirms')) THEN
    RAISE EXCEPTION 'change-name-8-steps UNDO: a name-change job is past step 2 — it cannot go back to the old 5 steps without losing where it is. Nothing changed.';
  END IF;
END
$do$;

-- jobs back to their old step name + number
UPDATE public.service_deliveries sd
   SET stage = b.data ->> 'stage', stage_order = (b.data ->> 'stage_order')::int
  FROM public.zz_change_name_8_steps_backup b
 WHERE b.kind = 'service_deliveries' AND b.ref = sd.id::text AND sd.service_type = 'Company Change Name';

-- steps: the 8 new rows out, the 5 old rows back (same ids)
DELETE FROM public.pipeline_stages WHERE service_type = 'Company Change Name';
INSERT INTO public.pipeline_stages
  SELECT (jsonb_populate_record(NULL::public.pipeline_stages, b.data)).*
    FROM public.zz_change_name_8_steps_backup b WHERE b.kind = 'pipeline_stages';

-- the cancelled workflow cards and the workflow status
UPDATE public.tasks t
   SET status = (b.data ->> 'status')::public.task_status, notes = b.data ->> 'notes', updated_at = now()
  FROM public.zz_change_name_8_steps_backup b
 WHERE b.kind = 'tasks' AND b.ref = t.id::text;
UPDATE public.catalog_entries ce
   SET status = b.data ->> 'status', updated_at = now()
  FROM public.zz_change_name_8_steps_backup b
 WHERE b.kind = 'workflow' AND b.ref = ce.id::text;

DO $do$
DECLARE
  v_list text;
BEGIN
  SELECT string_agg(stage_order || ':' || stage_name, ',' ORDER BY stage_order) INTO v_list
    FROM public.pipeline_stages WHERE service_type = 'Company Change Name';
  IF v_list IS DISTINCT FROM '1:Collect three company names,2:Inform Client name available,3:File the change name form,4:Ship change name form to teh SoS,5:Form Change Name received from the SoS' THEN
    RAISE EXCEPTION 'change-name-8-steps UNDO: unexpected step list after the restore: %', v_list;
  END IF;
  IF (SELECT count(*) FROM public.pipeline_stages WHERE service_type = 'Company Change Name' AND completes_service) <> 1 THEN
    RAISE EXCEPTION 'change-name-8-steps UNDO: the finishing step was not restored';
  END IF;
END
$do$;

DELETE FROM public.catalog_entries WHERE catalog_id = 'storage_client_safe_stages' AND slug = 'company_change_name';

DROP TABLE public.zz_change_name_8_steps_backup;
COMMIT;

SELECT 'change-name-8-steps undone' AS result;
