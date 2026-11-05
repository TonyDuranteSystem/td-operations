-- Company Closure workspace, PART A — Antonio 2026-11-05 ("go"): his own flow (offer -> client wizard -> we check -> file with the state -> state confirmation
--   -> EIN closure letter -> ship + tracking number -> wait for the IRS -> IRS letter finishes the job) as workspace screens, a chat box on every step, and
--   locks where he asked for them. Plan: "Company closure procedure and workspace" (dev job a6bbea09).
--
-- WHAT (Company Closure only):
--   1. pipeline_stages: a new step "Waiting for the IRS" at 5 (waiting on the IRS, the daily tracking check ON, its delivery message EMPTY = the client is told nothing,
--      leaving it needs the IRS letter uploaded on it, and the button that finishes the job ASKS first — for a company of ours it says the company will be closed); "Closing" moves from 5 to 6. service_deliveries keep their own copy of the step number, so they are re-synced.
--   2. A workspace screen (stage_layout) on every step — each with the chat box ("write to the client in the portal chat"); "State Dissolution Filing" now needs
--      the state’s confirmation uploaded on it before the job moves on (requires_document_to_advance); "IRS Closure" needs the tracking number saved
--      (irs_tracking_entry requiredToAdvance — enforced in lib/service-delivery.ts).
--   2b. "IRS Closure" is marked as OUR work (waiting_on us) — the waiting on the IRS now has its own step. The IRS-letter document type is created where missing (production has it).
--   3. "Closing": no email to the client when a job reaches it (notify_client_email OFF) — Antonio: "no closing email". (The portal bell for a step move is
--      the same as for every service and is untouched.)
--   4. Workflow closure_progress (the to-do card for Luca): the IRS button now goes to "Waiting for the IRS", and a new button there finishes the job at "Closing".
--      The pinned copy on OPEN closure cards is refreshed so cards already on the board get the new buttons.
-- NOT here (later parts): the wizard moving the job by itself, the "Company closure_<name>" folder, stopping the email to support, Wrap-up.
-- Re-runnable: every part checks before it acts. UNDO: 20261106-0100-closure-workspace-part-a.UNDO.sql (refuses while a job sits on "Waiting for the IRS").
-- Written for production's shape (5 steps, Closing last and finishing). Apply to SANDBOX first (node scripts/apply-migration.js); production only on Antonio’s word.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"closure-workspace-part-a-migration"}', true);

-- 1. The new step, and the jobs’ stored step number -------------------------------------------------------------
DO $do$
DECLARE
  v_closing_order int;
  v_closing_done  boolean;
  v_entry         uuid;
  v_list          text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'Waiting for the IRS') THEN
    RAISE NOTICE 'closure-workspace-a: step already present — skipping the step part';
  ELSE
    SELECT string_agg(stage_order || ':' || stage_name, ',' ORDER BY stage_order) INTO v_list
      FROM public.pipeline_stages WHERE service_type = 'Company Closure';
    IF v_list IS DISTINCT FROM '1:Data Collection,2:State Compliance Check,3:State Dissolution Filing,4:IRS Closure,5:Closing' THEN
      RAISE EXCEPTION 'closure-workspace-a: unexpected step list before the change: % — nothing changed', v_list;
    END IF;
    SELECT stage_order, completes_service, service_type_entry_id
      INTO v_closing_order, v_closing_done, v_entry
      FROM public.pipeline_stages
     WHERE service_type = 'Company Closure' AND stage_name = 'Closing'
       FOR UPDATE;
    IF v_closing_done IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'closure-workspace-a: "Closing" is expected to be the finishing step — nothing changed';
    END IF;

    UPDATE public.pipeline_stages SET stage_order = v_closing_order + 1
     WHERE service_type = 'Company Closure' AND stage_name = 'Closing';

    INSERT INTO public.pipeline_stages
      (service_type, stage_order, stage_name, stage_description, client_description, auto_tasks, auto_actions,
       sla_days, requires_approval, auto_advance, waiting_on, completes_service, requires_document_to_advance,
       notify_client_email, notify_client_chat, client_visible, board_visible, tracking_check_enabled,
       tracking_delivered_message, service_type_entry_id)
    VALUES
      ('Company Closure', v_closing_order, 'Waiting for the IRS',
       'The EIN closure letter is with the IRS. Wait for their letter saying the EIN is closed (usually 4 to 6 weeks); the tracking number is checked every day. When the letter arrives, upload it on this step and press the button that finishes the job.',
       'We have sent the letter closing your EIN to the IRS and are waiting for their confirmation. This usually takes 4 to 6 weeks.',
       '[]'::jsonb, '[]'::jsonb,
       42, false, false, 'the_irs', false, true,
       false, false, true, true, true,
       '', v_entry);

    UPDATE public.service_deliveries sd
       SET stage_order = ps.stage_order
      FROM public.pipeline_stages ps
     WHERE sd.service_type = 'Company Closure' AND ps.service_type = 'Company Closure' AND ps.stage_name = sd.stage
       AND sd.stage_order IS DISTINCT FROM ps.stage_order;
  END IF;
END
$do$;

-- 1b. The document type the IRS letter is filed under. It exists in production (staff added it); make sure it exists wherever this runs
--     (the sandbox did not have it, so the upload box could not offer it). Same name and settings as production; nothing is changed if it is there.
INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
SELECT 'storage_document_types', 'ein_cancellation_receipt_from_irs', 'EIN Cancellation Receipt from IRS', 'active',
       '{"custom": true, "personal": false, "staff_only": false, "legacy_category": 1, "proof_of_filing": false, "suggested_folder": "1. Company", "default_published": false, "freeze_when_filed": false, "default_folder_kind": "company", "draft_never_visible": false}'::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'storage_document_types' AND slug = 'ein_cancellation_receipt_from_irs');

-- 2. Step settings + the workspace screens ----------------------------------------------------------------------------
-- "IRS Closure" is now OUR work (print, mail, save the tracking number); the waiting on the IRS has its own step. So the Calendar shows it as ours.
UPDATE public.pipeline_stages SET waiting_on = 'us'
 WHERE service_type = 'Company Closure' AND stage_name = 'IRS Closure';
UPDATE public.pipeline_stages SET stage_layout = $j${"components":[{"type":"waiting_notice","label":"Waiting for the client to fill in the closure wizard in the portal (company name, EIN, Articles of Organization and EIN letter)."},{"type":"data_viewer","label":"Closure wizard answers"},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"Wizard received — check the documents","target":"State Compliance Check"}]}],"description":"The client got the closure wizard in the portal after paying. Their answers and uploads show here once they send it."}$j$::jsonb
 WHERE service_type = 'Company Closure' AND stage_name = 'Data Collection';
UPDATE public.pipeline_stages SET stage_layout = $j${"components":[{"type":"info_panel"},{"type":"data_viewer","label":"Closure wizard answers"},{"type":"document_viewer","collapsible":true},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"Documents and state fees checked — file with the state","target":"State Dissolution Filing"}]}],"description":"Check the documents the client uploaded and check the state for unpaid fees or taxes BEFORE filing. If something blocks the filing, write to the client in the chat below."}$j$::jsonb
 WHERE service_type = 'Company Closure' AND stage_name = 'State Compliance Check';
UPDATE public.pipeline_stages SET stage_layout = $j${"components":[{"type":"waiting_notice","label":"File the dissolution with the state, then wait for the state’s confirmation."},{"type":"document_upload","label":"Upload the state’s confirmation","documentType":"certificate_of_dissolution","autoAdvance":false,"storageHint":{"asks":"the state’s confirmation that the company is dissolved","effects":["attach it to the case as the state’s confirmation","unlock the next step (the EIN closure letter)"]}},{"type":"document_viewer","collapsible":true},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"State confirmed — prepare the EIN closure letter","target":"IRS Closure"}]}],"description":"Fill out the Articles of Dissolution and file them with the state (Wyoming and Delaware by mail, New Mexico and Florida in the state portal), then wait for the state’s confirmation. The next step stays locked until the confirmation is uploaded here."}$j$::jsonb, requires_document_to_advance = true
 WHERE service_type = 'Company Closure' AND stage_name = 'State Dissolution Filing';
UPDATE public.pipeline_stages SET stage_layout = $j${"components":[{"type":"waiting_notice","label":"Prepare the EIN closure letter, mail it to the IRS and save the tracking number below."},{"type":"document_upload","label":"Upload the EIN closure letter (as sent)","documentType":"ein_cancellation_request","autoAdvance":false,"storageHint":{"asks":"the EIN closure letter as it was sent to the IRS","effects":["attach it to the case as the EIN closure letter"]}},{"type":"irs_tracking_entry","requiredToAdvance":true,"helpText":"Required before the job can move on. Once it is saved, the system checks it every day and shows here when the letter is delivered."},{"type":"document_viewer","collapsible":true},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"Shipped to the IRS — wait for their answer","target":"Waiting for the IRS"}]}],"description":"Fill out the EIN closure letter, print it and mail it to the IRS (Cincinnati, OH). If a final tax return is needed, India prepares it and it goes in the same envelope. Save the tracking number below — the next step stays locked until it is saved."}$j$::jsonb
 WHERE service_type = 'Company Closure' AND stage_name = 'IRS Closure';
UPDATE public.pipeline_stages SET stage_layout = $j${"components":[{"type":"waiting_notice","label":"Waiting for the IRS — usually 4 to 6 weeks. When their letter saying the EIN is closed arrives, upload it below, then press the button to finish the job."},{"type":"irs_tracking_entry","helpText":"Save the tracking number of the letter we mailed. The system checks it every day and shows here when it is delivered."},{"type":"document_upload","label":"Upload the IRS letter (EIN closed)","documentType":"ein_cancellation_receipt_from_irs","autoAdvance":false,"storageHint":{"asks":"the IRS letter saying the EIN is closed","effects":["attach it to the case as the IRS confirmation","unlock the “Finish the job” button"]}},{"type":"document_viewer","collapsible":true},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"IRS letter received — finish the job","target":"Closing","confirm":"Finish the closure job? The IRS letter is in the file.","confirmCompany":"Finishing this job CLOSES THE COMPANY in the CRM: the account is set to Closed, the portal is turned off and the company’s other open services are cancelled. Finish the job?"}]}],"description":"The EIN closure letter is with the IRS. This step stays open until their letter arrives; upload it, then finish the job (the button asks first)."}$j$::jsonb
 WHERE service_type = 'Company Closure' AND stage_name = 'Waiting for the IRS';
UPDATE public.pipeline_stages SET stage_layout = $j${"components":[{"type":"info_panel"},{"type":"document_viewer","collapsible":true},{"type":"chat"}],"description":"The IRS confirmed the EIN is closed. The job is complete."}$j$::jsonb, notify_client_email = false
 WHERE service_type = 'Company Closure' AND stage_name = 'Closing';

-- 3. Workflow closure_progress (the to-do card) ----------------------------------------------------------------------
DO $do$
DECLARE
  v_wf_id   uuid;
  v_before  jsonb;
  v_actions jsonb;
  v_changed boolean := false;
  v_new     jsonb;
  v_pos     int;
BEGIN
  SELECT id, metadata INTO v_wf_id, v_before
    FROM public.catalog_entries WHERE catalog_id = 'task_workflows' AND slug = 'closure_progress' FOR UPDATE;
  IF v_wf_id IS NULL THEN
    RAISE EXCEPTION 'closure-workspace-a: workflow closure_progress not found — nothing changed';
  END IF;
  v_actions := v_before -> 'actions';

  -- the IRS button now goes to the new waiting step
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_actions) a
              WHERE a ->> 'slug' = 'confirm_irs_closure' AND a #>> '{handler_params,target_stage}' IS DISTINCT FROM 'Waiting for the IRS') THEN
    SELECT jsonb_agg(
             CASE WHEN a ->> 'slug' = 'confirm_irs_closure' THEN
               jsonb_set(jsonb_set(jsonb_set(jsonb_set(a,
                 '{handler_params,target_stage}', '"Waiting for the IRS"'::jsonb),
                 '{label_admin}', '"Shipped to the IRS → Waiting for the IRS"'::jsonb),
                 '{confirm,summary}', '"Confirm the EIN closure letter was mailed to the IRS (tracking number saved) and move the job to Waiting for the IRS?"'::jsonb),
                 '{on_success_meta,workflow_state}', '"Waiting for the IRS"'::jsonb)
             ELSE a END ORDER BY ord)
      INTO v_actions
      FROM jsonb_array_elements(v_actions) WITH ORDINALITY AS t(a, ord);
    v_changed := true;
  END IF;

  -- the new button that finishes the job
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_actions) a WHERE a ->> 'slug' = 'confirm_irs_confirmed') THEN
    v_new := $j${
      "icon": "FileCheck2",
      "slug": "confirm_irs_confirmed",
      "color": "green",
      "confirm": {"summary": "The IRS letter saying the EIN is closed is uploaded — finish the job? For a company of ours this also closes the company in the CRM (account Closed, portal off, open services cancelled)."},
      "handler": "chain.advance_sd_stage",
      "permission": {"role_in": ["admin", "team"]},
      "label_admin": "IRS Letter Received → Finish the job",
      "visible_when": {"sd_stage": "Waiting for the IRS"},
      "handler_params": {"target_stage": "Closing"},
      "on_success_meta": {"workflow_state": "Closing"},
      "on_success_status": "Done"
    }$j$::jsonb;
    SELECT ord INTO v_pos FROM jsonb_array_elements(v_actions) WITH ORDINALITY AS t(a, ord) WHERE a ->> 'slug' = 'confirm_irs_closure';
    IF v_pos IS NULL THEN
      RAISE EXCEPTION 'closure-workspace-a: button confirm_irs_closure not found — nothing changed';
    END IF;
    SELECT jsonb_agg(x ORDER BY o) INTO v_actions FROM (
      SELECT a AS x, ord * 2 AS o FROM jsonb_array_elements(v_actions) WITH ORDINALITY AS t(a, ord)
      UNION ALL SELECT v_new, v_pos * 2 + 1
    ) s;
    v_changed := true;
  END IF;

  IF v_changed THEN
    UPDATE public.catalog_entries SET metadata = jsonb_set(v_before, '{actions}', v_actions), updated_at = now() WHERE id = v_wf_id;
    INSERT INTO public.catalog_decision_log (catalog_entry_id, catalog_id, action, actor_kind, reason, before_state, after_state)
    VALUES (v_wf_id, 'task_workflows', 'metadata_changed', 'migration',
            'Company Closure workspace part A: IRS button goes to Waiting for the IRS, new button finishes the job (dev job a6bbea09)',
            jsonb_build_object('slug', 'closure_progress', 'actions', (SELECT jsonb_agg(a ->> 'slug') FROM jsonb_array_elements(v_before -> 'actions') a)),
            jsonb_build_object('slug', 'closure_progress', 'actions', (SELECT jsonb_agg(a ->> 'slug') FROM jsonb_array_elements(v_actions) a)));
  ELSE
    RAISE NOTICE 'closure-workspace-a: workflow buttons already up to date';
  END IF;

  -- Open cards carry a pinned copy of the workflow: refresh them (slug merged in, as buildSnapshotForStorage does).
  UPDATE public.tasks t
     SET workflow_snapshot = ce.metadata || jsonb_build_object('slug', ce.slug)
    FROM public.catalog_entries ce
   WHERE ce.id = v_wf_id
     AND t.workflow_slug = 'closure_progress'
     AND t.status NOT IN ('Done', 'Cancelled')
     AND t.workflow_snapshot IS DISTINCT FROM (ce.metadata || jsonb_build_object('slug', ce.slug));
END
$do$;

-- 4. Check the result: refuse to commit anything that does not look exactly as intended -----------------------------
DO $do$
DECLARE
  v_list text;
  v_irs  text;
  v_n    int;
BEGIN
  SELECT string_agg(stage_order || ':' || stage_name, ',' ORDER BY stage_order) INTO v_list
    FROM public.pipeline_stages WHERE service_type = 'Company Closure';
  IF v_list IS DISTINCT FROM '1:Data Collection,2:State Compliance Check,3:State Dissolution Filing,4:IRS Closure,5:Waiting for the IRS,6:Closing' THEN
    RAISE EXCEPTION 'closure-workspace-a: unexpected step list after the change: %', v_list;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'Waiting for the IRS'
                   AND waiting_on = 'the_irs' AND completes_service = false AND tracking_check_enabled = true
                   AND requires_document_to_advance = true AND tracking_delivered_message = '' AND stage_order = 5)
     OR NOT EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'Closing'
                   AND completes_service = true AND notify_client_email = false AND stage_order = 6)
     OR NOT EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'State Dissolution Filing'
                   AND requires_document_to_advance = true) THEN
    RAISE EXCEPTION 'closure-workspace-a: step settings are not as intended';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'IRS Closure' AND waiting_on = 'us')
     OR NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'storage_document_types' AND slug = 'ein_cancellation_receipt_from_irs' AND status = 'active') THEN
    RAISE EXCEPTION 'closure-workspace-a: IRS Closure waiting_on or the IRS-letter document type is not as intended';
  END IF;
  SELECT count(*) INTO v_n FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_layout IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'closure-workspace-a: % closure step(s) still have no workspace screen', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.service_deliveries sd JOIN public.pipeline_stages ps
               ON ps.service_type = 'Company Closure' AND ps.stage_name = sd.stage
              WHERE sd.service_type = 'Company Closure' AND sd.stage_order IS DISTINCT FROM ps.stage_order) THEN
    RAISE EXCEPTION 'closure-workspace-a: some closure jobs still carry an old step number';
  END IF;
  SELECT a #>> '{handler_params,target_stage}' INTO v_irs
    FROM public.catalog_entries ce, jsonb_array_elements(ce.metadata -> 'actions') a
   WHERE ce.catalog_id = 'task_workflows' AND ce.slug = 'closure_progress' AND a ->> 'slug' = 'confirm_irs_closure';
  IF v_irs IS DISTINCT FROM 'Waiting for the IRS' THEN
    RAISE EXCEPTION 'closure-workspace-a: workflow IRS button is not as intended (%)', v_irs;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tasks WHERE workflow_slug = 'closure_progress' AND status NOT IN ('Done', 'Cancelled')
               AND NOT (workflow_snapshot -> 'actions') @> '[{"slug": "confirm_irs_confirmed"}]'::jsonb) THEN
    RAISE EXCEPTION 'closure-workspace-a: some open closure cards did not get the new button';
  END IF;
END
$do$;

COMMIT;
