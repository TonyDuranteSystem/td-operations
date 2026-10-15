-- UNDO for 20261015-1200-closure-wrapup-step.sql — puts Company Closure back to five steps with "Closing" at 5 and its
-- original text and to-dos, and puts the two workflow buttons back as they were.
-- REFUSES while ANY closure job sits on "Wrap-up" (the step cannot be removed from under a live job — move those jobs
-- back to "IRS Closure" or on to "Closing" first, then run this).

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"closure-wrapup-undo"}', true);

DO $do$
DECLARE
  v_wrap_order int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_deliveries WHERE service_type = 'Company Closure' AND stage = 'Wrap-up') THEN
    RAISE EXCEPTION 'closure-wrapup UNDO: closure jobs still sit on Wrap-up — move them first; nothing changed';
  END IF;

  SELECT stage_order INTO v_wrap_order FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'Wrap-up';
  IF v_wrap_order IS NULL THEN
    RAISE NOTICE 'closure-wrapup UNDO: no Wrap-up step — skipping the step part';
  ELSE
    DELETE FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'Wrap-up';
    UPDATE public.pipeline_stages
       SET stage_order = v_wrap_order,
           stage_description = 'All closure steps complete. Cancel Registered Agent on Harbor Compliance. Cancel CMRA/lease if active. Remove from Annual Renewal pipeline. Update account status to Inactive. Notify client that closure is complete.',
           auto_tasks = $j$[
             {"title": "Cancel Registered Agent on Harbor Compliance", "category": "Filing", "assigned_to": "Luca"},
             {"title": "Cancel CMRA/lease if active", "category": "Filing", "assigned_to": "Luca"},
             {"title": "Remove from Annual Renewal pipeline", "category": "CRM Update", "assigned_to": "Luca"},
             {"title": "Update account status to Inactive", "category": "CRM Update", "assigned_to": "Luca"},
             {"title": "Notify client that closure is complete", "category": "Client Communication", "assigned_to": "Luca"}
           ]$j$::jsonb
     WHERE service_type = 'Company Closure' AND stage_name = 'Closing';
  END IF;

  UPDATE public.service_deliveries sd
     SET stage_order = ps.stage_order
    FROM public.pipeline_stages ps
   WHERE sd.service_type = 'Company Closure' AND ps.service_type = 'Company Closure' AND ps.stage_name = sd.stage
     AND sd.stage_order IS DISTINCT FROM ps.stage_order;
END
$do$;

DO $do$
DECLARE
  v_wf_id   uuid;
  v_before  jsonb;
  v_actions jsonb;
  v_changed boolean := false;
BEGIN
  SELECT id, metadata INTO v_wf_id, v_before
    FROM public.catalog_entries WHERE catalog_id = 'task_workflows' AND slug = 'closure_progress' FOR UPDATE;
  IF v_wf_id IS NULL THEN
    RAISE EXCEPTION 'closure-wrapup UNDO: workflow closure_progress not found — nothing changed';
  END IF;
  v_actions := v_before -> 'actions';

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_actions) a WHERE a ->> 'slug' = 'confirm_wrapup_done') THEN
    SELECT jsonb_agg(a ORDER BY ord) INTO v_actions
      FROM jsonb_array_elements(v_actions) WITH ORDINALITY AS t(a, ord) WHERE a ->> 'slug' <> 'confirm_wrapup_done';
    v_changed := true;
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_actions) a
              WHERE a ->> 'slug' = 'confirm_irs_closure' AND a #>> '{handler_params,target_stage}' IS DISTINCT FROM 'Closing') THEN
    SELECT jsonb_agg(
             CASE WHEN a ->> 'slug' = 'confirm_irs_closure' THEN
               jsonb_set(jsonb_set(jsonb_set(jsonb_set(a,
                 '{handler_params,target_stage}', '"Closing"'::jsonb),
                 '{label_admin}', '"IRS Closure Complete → Closing"'::jsonb),
                 '{confirm,summary}', '"Confirm IRS final filings complete and advance to Closing?"'::jsonb),
                 '{on_success_meta,workflow_state}', '"Closing"'::jsonb)
             ELSE a END ORDER BY ord)
      INTO v_actions
      FROM jsonb_array_elements(v_actions) WITH ORDINALITY AS t(a, ord);
    v_changed := true;
  END IF;

  IF v_changed THEN
    UPDATE public.catalog_entries SET metadata = jsonb_set(v_before, '{actions}', v_actions), updated_at = now() WHERE id = v_wf_id;
    INSERT INTO public.catalog_decision_log (catalog_entry_id, catalog_id, action, actor_kind, reason, before_state, after_state)
    VALUES (v_wf_id, 'task_workflows', 'metadata_changed', 'migration',
            'UNDO of the Company Closure Wrap-up step (dev job be7da01a)',
            jsonb_build_object('slug', 'closure_progress', 'actions', (SELECT jsonb_agg(a ->> 'slug') FROM jsonb_array_elements(v_before -> 'actions') a)),
            jsonb_build_object('slug', 'closure_progress', 'actions', (SELECT jsonb_agg(a ->> 'slug') FROM jsonb_array_elements(v_actions) a)));
  END IF;

  UPDATE public.tasks t
     SET workflow_snapshot = ce.metadata || jsonb_build_object('slug', ce.slug)
    FROM public.catalog_entries ce
   WHERE ce.id = v_wf_id
     AND t.workflow_slug = 'closure_progress'
     AND t.status NOT IN ('Done', 'Cancelled')
     AND t.workflow_snapshot IS DISTINCT FROM (ce.metadata || jsonb_build_object('slug', ce.slug));
END
$do$;

DO $do$
DECLARE
  v_list text;
BEGIN
  SELECT string_agg(stage_order || ':' || stage_name, ',' ORDER BY stage_order) INTO v_list
    FROM public.pipeline_stages WHERE service_type = 'Company Closure';
  IF v_list IS DISTINCT FROM '1:Data Collection,2:State Compliance Check,3:State Dissolution Filing,4:IRS Closure,5:Closing' THEN
    RAISE EXCEPTION 'closure-wrapup UNDO: unexpected step list after the undo: %', v_list;
  END IF;
END
$do$;

COMMIT;
