-- UNDO for 20261106-0100-closure-workspace-part-a.sql — puts Company Closure back to five steps (Closing at 5, no workspace screens, "no closing email" back to ON,
-- the state step no longer needs a document) and the IRS button back to "Closing". REFUSES while ANY closure job sits on "Waiting for the IRS"
-- (the step cannot be removed from under a live job — move those jobs back to "IRS Closure" or on to "Closing" first).
-- Screens are removed only where they are still exactly what the migration wrote.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"closure-workspace-part-a-undo"}', true);

DO $do$
DECLARE
  v_wait_order int;
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_deliveries WHERE service_type = 'Company Closure' AND stage = 'Waiting for the IRS') THEN
    RAISE EXCEPTION 'closure-workspace-a UNDO: closure jobs still sit on Waiting for the IRS — move them first; nothing changed';
  END IF;

  SELECT stage_order INTO v_wait_order FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'Waiting for the IRS';
  IF v_wait_order IS NULL THEN
    RAISE NOTICE 'closure-workspace-a UNDO: no Waiting for the IRS step — skipping the step part';
  ELSE
    DELETE FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'Waiting for the IRS';
    UPDATE public.pipeline_stages SET stage_order = v_wait_order
     WHERE service_type = 'Company Closure' AND stage_name = 'Closing';
  END IF;

  UPDATE public.service_deliveries sd
     SET stage_order = ps.stage_order
    FROM public.pipeline_stages ps
   WHERE sd.service_type = 'Company Closure' AND ps.service_type = 'Company Closure' AND ps.stage_name = sd.stage
     AND sd.stage_order IS DISTINCT FROM ps.stage_order;
END
$do$;

UPDATE public.pipeline_stages SET stage_layout = NULL
 WHERE service_type = 'Company Closure' AND stage_name = 'Data Collection' AND stage_layout = $j${"components":[{"type":"waiting_notice","label":"Waiting for the client to fill in the closure wizard in the portal (company name, EIN, Articles of Organization and EIN letter)."},{"type":"data_viewer","label":"Closure wizard answers"},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"Wizard received — check the documents","target":"State Compliance Check"}]}],"description":"The client got the closure wizard in the portal after paying. Their answers and uploads show here once they send it."}$j$::jsonb;
UPDATE public.pipeline_stages SET stage_layout = NULL
 WHERE service_type = 'Company Closure' AND stage_name = 'State Compliance Check' AND stage_layout = $j${"components":[{"type":"info_panel"},{"type":"data_viewer","label":"Closure wizard answers"},{"type":"document_viewer","collapsible":true},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"Documents and state fees checked — file with the state","target":"State Dissolution Filing"}]}],"description":"Check the documents the client uploaded and check the state for unpaid fees or taxes BEFORE filing. If something blocks the filing, write to the client in the chat below."}$j$::jsonb;
UPDATE public.pipeline_stages SET requires_document_to_advance = false
 WHERE service_type = 'Company Closure' AND stage_name = 'State Dissolution Filing';
UPDATE public.pipeline_stages SET stage_layout = NULL
 WHERE service_type = 'Company Closure' AND stage_name = 'State Dissolution Filing' AND stage_layout = $j${"components":[{"type":"waiting_notice","label":"File the dissolution with the state, then wait for the state’s confirmation."},{"type":"document_upload","label":"Upload the state’s confirmation","documentType":"certificate_of_dissolution","autoAdvance":false,"storageHint":{"asks":"the state’s confirmation that the company is dissolved","effects":["attach it to the case as the state’s confirmation","unlock the next step (the EIN closure letter)"]}},{"type":"document_viewer","collapsible":true},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"State confirmed — prepare the EIN closure letter","target":"IRS Closure"}]}],"description":"Fill out the Articles of Dissolution and file them with the state (Wyoming and Delaware by mail, New Mexico and Florida in the state portal), then wait for the state’s confirmation. The next step stays locked until the confirmation is uploaded here."}$j$::jsonb;
UPDATE public.pipeline_stages SET stage_layout = NULL
 WHERE service_type = 'Company Closure' AND stage_name = 'IRS Closure' AND stage_layout = $j${"components":[{"type":"waiting_notice","label":"Prepare the EIN closure letter, mail it to the IRS and save the tracking number below."},{"type":"document_upload","label":"Upload the EIN closure letter (as sent)","documentType":"ein_cancellation_request","autoAdvance":false,"storageHint":{"asks":"the EIN closure letter as it was sent to the IRS","effects":["attach it to the case as the EIN closure letter"]}},{"type":"irs_tracking_entry","requiredToAdvance":true,"helpText":"Required before the job can move on. Once it is saved, the system checks it every day and shows here when the letter is delivered."},{"type":"document_viewer","collapsible":true},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"Shipped to the IRS — wait for their answer","target":"Waiting for the IRS"}]}],"description":"Fill out the EIN closure letter, print it and mail it to the IRS (Cincinnati, OH). If a final tax return is needed, India prepares it and it goes in the same envelope. Save the tracking number below — the next step stays locked until it is saved."}$j$::jsonb;
UPDATE public.pipeline_stages SET waiting_on = 'outside'
 WHERE service_type = 'Company Closure' AND stage_name = 'IRS Closure' AND waiting_on = 'us';
UPDATE public.pipeline_stages SET notify_client_email = true
 WHERE service_type = 'Company Closure' AND stage_name = 'Closing';
UPDATE public.pipeline_stages SET stage_layout = NULL
 WHERE service_type = 'Company Closure' AND stage_name = 'Closing' AND stage_layout = $j${"components":[{"type":"info_panel"},{"type":"document_viewer","collapsible":true},{"type":"chat"}],"description":"The IRS confirmed the EIN is closed. The job is complete."}$j$::jsonb;

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
    RAISE EXCEPTION 'closure-workspace-a UNDO: workflow closure_progress not found — nothing changed';
  END IF;
  v_actions := v_before -> 'actions';

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_actions) a WHERE a ->> 'slug' = 'confirm_irs_confirmed') THEN
    SELECT jsonb_agg(a ORDER BY ord) INTO v_actions
      FROM jsonb_array_elements(v_actions) WITH ORDINALITY AS t(a, ord) WHERE a ->> 'slug' <> 'confirm_irs_confirmed';
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
            'UNDO of the Company Closure workspace part A (dev job a6bbea09)',
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
    RAISE EXCEPTION 'closure-workspace-a UNDO: unexpected step list after the undo: %', v_list;
  END IF;
END
$do$;

COMMIT;
