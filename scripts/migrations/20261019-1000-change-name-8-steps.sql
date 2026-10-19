-- Company Change Name: the 8-step service (7 steps the client sees + a closing step) with a workspace on every step
-- — dev job bb64c417 (track B1), Antonio 2026-10-19.
--
-- WHY: a name change had 5 empty steps (no workspace tools, no client wording, a typo in step 4) and no step for the
--   client signing the state's form, for updating our records, or for the client's new Operating Agreement. The names loop,
--   the e-sign of the form and the client's portal page now exist in code; this gives them their steps.
--
-- WHAT (Company Change Name only):
--   1. pipeline_stages: 5 steps become 8.
--        1 Collect three company names            (client)   unchanged name
--        2 Check names and client confirms        (us)       was "Inform Client name available"
--        3 Client signs the name-change form      (client)   NEW
--        4 File the form with the state           (us)       was "File the change name form"
--        5 Waiting for the state                  (outside)  was "Ship change name form to teh SoS" (the typo goes)
--        6 Update our records                     (us)       was "Form Change Name received from the SoS"
--        7 Client updates the Operating Agreement (client)   NEW
--        8 Completed                              (nobody)   NEW, the ONLY finishing step (was step 5)
--      each with client wording (EN/IT) and its workspace layout (existing building blocks only); step 8 is bookkeeping and is
--      not shown to the client; step 5 needs the state's stamped document before the job may move on.
--   2. service_deliveries: every name-change job's step name + number are re-keyed (a job that was already completed at the old
--      last step goes to "Completed"; an active one to "Update our records").
--   3. Open to-do cards of the workflow company_change_name_workflow are cancelled (the Calendar is the to-do) and the workflow is
--      set to draft (the dispatcher ignores drafts) — new jobs spawn no card; createSD no longer makes a plain fallback card for this service.
--   4. The state's stamped document (uploaded at "Waiting for the state") is client-visible: one catalog row, storage_client_safe_stages
--      / company_change_name, the database twin of CLIENT_SAFE_FLOW_DOC_STAGES in lib/flows/flow-doc-visibility.ts.
--   5. Everything touched is first copied into public.zz_change_name_8_steps_backup (the UNDO restores from it).
--   Not touched: stage_history of the jobs (history), anything of another service.
-- ONE transaction; every part checks before it acts (re-runnable); the end refuses to commit anything that does not look exactly as intended.
-- UNDO: 20261019-1000-change-name-8-steps.UNDO.sql (refuses unless every name-change job still sits on step 1 or 2).
-- Apply to SANDBOX first (node scripts/apply-migration.js); production = pasted by Antonio in the Supabase SQL editor, only on his word.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"change-name-8-steps-migration"}', true);

-- 0. Backup table (kept after the change; the UNDO restores from it and drops it) -------------------------------------------
CREATE TABLE IF NOT EXISTS public.zz_change_name_8_steps_backup (
  id         bigserial PRIMARY KEY,
  kind       text        NOT NULL,
  ref        text,
  data       jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.zz_change_name_8_steps_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zz_change_name_8_steps_backup FROM PUBLIC, anon, authenticated;
-- the marketing database lock must be run again by every migration that creates a table (it only exists where the marketing
-- migration has been applied; the table above is already closed to every login role either way)
DO $do$
BEGIN
  IF to_regprocedure('public.marketing_lock_all_tables()') IS NOT NULL THEN
    PERFORM public.marketing_lock_all_tables();
  END IF;
END
$do$;

-- 1. Preflight: the five old steps, or the eight new ones already (then nothing below changes) ------------------------------
DO $do$
DECLARE
  v_list text;
BEGIN
  SELECT string_agg(stage_order || ':' || stage_name, ',' ORDER BY stage_order) INTO v_list
    FROM public.pipeline_stages WHERE service_type = 'Company Change Name';
  IF v_list = '1:Collect three company names,2:Check names and client confirms,3:Client signs the name-change form,4:File the form with the state,5:Waiting for the state,6:Update our records,7:Client updates the Operating Agreement,8:Completed' THEN
    RAISE NOTICE 'change-name-8-steps: the 8 steps are already in place — the step part is skipped';
  ELSIF v_list IS DISTINCT FROM '1:Collect three company names,2:Inform Client name available,3:File the change name form,4:Ship change name form to teh SoS,5:Form Change Name received from the SoS' THEN
    RAISE EXCEPTION 'change-name-8-steps: unexpected step list for Company Change Name (%) — nothing changed', v_list;
  END IF;
END
$do$;

-- 2. Backup what is about to change (only on the first run) --------------------------------------------------------------------
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Change Name' AND stage_name = 'Inform Client name available')
     AND NOT EXISTS (SELECT 1 FROM public.zz_change_name_8_steps_backup WHERE kind = 'pipeline_stages') THEN
    INSERT INTO public.zz_change_name_8_steps_backup (kind, ref, data)
      SELECT 'pipeline_stages', ps.id::text, to_jsonb(ps) FROM public.pipeline_stages ps WHERE ps.service_type = 'Company Change Name';
    INSERT INTO public.zz_change_name_8_steps_backup (kind, ref, data)
      SELECT 'service_deliveries', sd.id::text, jsonb_build_object('stage', sd.stage, 'stage_order', sd.stage_order, 'status', sd.status)
        FROM public.service_deliveries sd WHERE sd.service_type = 'Company Change Name';
    INSERT INTO public.zz_change_name_8_steps_backup (kind, ref, data)
      SELECT 'tasks', t.id::text, jsonb_build_object('status', t.status, 'notes', t.notes, 'task_meta', t.task_meta)
        FROM public.tasks t WHERE t.workflow_slug = 'company_change_name_workflow' AND t.status NOT IN ('Done', 'Cancelled');
    INSERT INTO public.zz_change_name_8_steps_backup (kind, ref, data)
      SELECT 'workflow', ce.id::text, jsonb_build_object('status', ce.status)
        FROM public.catalog_entries ce WHERE ce.catalog_id = 'task_workflows' AND ce.slug = 'company_change_name_workflow';
  END IF;
END
$do$;

-- 3. The steps ---------------------------------------------------------------------------------------------------------------------
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Change Name' AND stage_name = 'Inform Client name available') THEN
    -- the only finishing step moves to the new last step: clear it first (one finishing step per service), then park every step out of the way
    UPDATE public.pipeline_stages SET completes_service = false WHERE service_type = 'Company Change Name';
    UPDATE public.pipeline_stages SET stage_order = stage_order + 100000 WHERE service_type = 'Company Change Name';

    UPDATE public.pipeline_stages SET stage_order = 2, stage_name = 'Check names and client confirms'
     WHERE service_type = 'Company Change Name' AND stage_name = 'Inform Client name available';
    UPDATE public.pipeline_stages SET stage_order = 4, stage_name = 'File the form with the state'
     WHERE service_type = 'Company Change Name' AND stage_name = 'File the change name form';
    UPDATE public.pipeline_stages SET stage_order = 5, stage_name = 'Waiting for the state'
     WHERE service_type = 'Company Change Name' AND stage_name = 'Ship change name form to teh SoS';
    UPDATE public.pipeline_stages SET stage_order = 6, stage_name = 'Update our records'
     WHERE service_type = 'Company Change Name' AND stage_name = 'Form Change Name received from the SoS';
    UPDATE public.pipeline_stages SET stage_order = 1
     WHERE service_type = 'Company Change Name' AND stage_name = 'Collect three company names';

    INSERT INTO public.pipeline_stages
      (service_type, stage_order, stage_name, auto_tasks, auto_actions, requires_approval, auto_advance, waiting_on,
       completes_service, requires_document_to_advance, notify_client_email, notify_client_chat, client_visible, board_visible,
       tracking_check_enabled, service_type_entry_id)
    VALUES
      ('Company Change Name', 3, 'Client signs the name-change form',       '[]'::jsonb, '[]'::jsonb, false, false, 'client', false, false, false, false, true,  true, false, NULL),
      ('Company Change Name', 7, 'Client updates the Operating Agreement',  '[]'::jsonb, '[]'::jsonb, false, false, 'client', false, false, false, false, true,  true, false, NULL),
      ('Company Change Name', 8, 'Completed',                               '[]'::jsonb, '[]'::jsonb, false, false, 'none',   true,  false, true,  false, false, true, false, NULL);
  END IF;
END
$do$;

-- 4. What each step says and shows (settings; the layouts use existing building blocks only) ----------------------------------------
UPDATE public.pipeline_stages ps
   SET waiting_on        = v.waiting_on,
       client_label      = v.client_label,
       client_label_it   = v.client_label_it,
       client_description = v.client_description,
       stage_description = v.stage_description,
       stage_layout      = v.layout::jsonb,
       auto_advance      = false,
       completes_service = (v.stage_name = 'Completed'),
       notify_client_email = (v.stage_name = 'Completed'),
       client_visible    = (v.stage_name <> 'Completed'),
       board_visible     = true
  FROM (VALUES
    ('Collect three company names', 'client',
     'Send us your names', 'Inviaci i tuoi nomi',
     'Tell us up to three names you would like for your company, in order of preference.',
     'Waiting for the client''s names. The client is asked in the portal (an "Action required" card); a name he sends by chat can be typed in here.',
     $j${"description":"The client was asked for his names in the portal. They appear here when he answers and the job moves to the next step by itself.","components":[{"type":"waiting_notice","label":"Waiting for the client to send his names"},{"type":"formation_names"},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"Names received: check them","target":"Check names and client confirms"}]}]}$j$),
    ('Check names and client confirms', 'us',
     'We check the names and you confirm one', 'Verifichiamo i nomi e tu ne confermi uno',
     'We check your names with the state. When a name is available, we ask you to confirm it before we file.',
     'Check each name with the state, send ONE available name to the client to confirm, then prepare the state form with the confirmed name and send it for signature.',
     $j${"description":"Check each name with the state (Available / Not available), send one available name to the client, then prepare the form with the confirmed name and send it for signature.","components":[{"type":"formation_names"},{"type":"esign_panel","label":"Prepare the form for signature"},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"Form sent: waiting for the client to sign","target":"Client signs the name-change form"}]}]}$j$),
    ('Client signs the name-change form', 'client',
     'You sign the name-change form', 'Firma il modulo di cambio nome',
     'We prepare the name-change form with your confirmed name and send it to you to sign in your portal.',
     'Waiting for the client to e-sign the form. The job moves to the filing step by itself once he has signed.',
     $j${"description":"The form is with the client. When he has signed, the job moves to the next step by itself.","components":[{"type":"waiting_notice","label":"Waiting for the client to sign the form"},{"type":"esign_panel","label":"Prepare another form for signature"},{"type":"formation_names"},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"Signed: file with the state","target":"File the form with the state"}]}]}$j$),
    ('File the form with the state', 'us',
     'We file the form with the state', 'Presentiamo il modulo allo stato',
     'We file your signed form with the Secretary of State.',
     'File the signed form with the state (online or by mail), mark the name as filed and upload the proof.',
     $j${"description":"File the signed form with the state, mark the name as filed, upload the proof of filing, then move on.","components":[{"type":"formation_names"},{"type":"document_upload","label":"Upload the filed form (proof of filing)","folder":"1. Company","rename":"Name change filing – {company_name}","autoAdvance":false},{"type":"document_viewer"},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"Filed: waiting for the state","target":"Waiting for the state"}]}]}$j$),
    ('Waiting for the state', 'outside',
     'Waiting for the state', 'In attesa dello stato',
     'The state is processing the change. We follow up and keep you posted.',
     'The state has the form. When it answers: upload the state''s stamped document and press State accepted — or mark the name refused and send the job back for a new name.',
     $j${"description":"Waiting for the state's answer. Upload the stamped document when it arrives. If the state refuses the name, mark it refused in the names list and send the job back for a new name.","components":[{"type":"waiting_notice","label":"Waiting for the state"},{"type":"formation_names"},{"type":"document_upload","label":"Upload the state's stamped document","folder":"1. Company","rename":"State approved name change – {company_name}","autoAdvance":false},{"type":"document_viewer"},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"State accepted: update our records","target":"Update our records"}]}]}$j$),
    ('Update our records', 'us',
     'We update your records', 'Aggiorniamo i tuoi dati',
     'The state approved your new name. We update your company records and your document folder.',
     'Apply the new name to our records (company name, previous name, the document folder), then ask the client for the new Operating Agreement.',
     $j${"description":"The state approved the new name. Update the company record and the document folder, then ask the client for the new Operating Agreement.","components":[{"type":"info_panel"},{"type":"document_viewer"},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"Records updated: ask the client for the Operating Agreement","target":"Client updates the Operating Agreement"}]}]}$j$),
    ('Client updates the Operating Agreement', 'client',
     'Update your Operating Agreement', 'Aggiorna il tuo Operating Agreement',
     'Generate the new version of your Operating Agreement in your portal so it carries your new company name.',
     'Waiting for the client to generate the new Operating Agreement in the portal (Generate Documents).',
     $j${"description":"The client generates the new version of the Operating Agreement in the portal. When it is in, close the job.","components":[{"type":"waiting_notice","label":"Waiting for the client to generate the new Operating Agreement"},{"type":"document_viewer"},{"type":"chat"},{"type":"action_buttons","actions":[{"key":"advance_next","label":"Operating Agreement received: close the job","target":"Completed"}]}]}$j$),
    ('Completed', 'none',
     'Completed', 'Completato',
     'Your company name change is complete.',
     'Done. The client is told the name change is complete.',
     $j${"description":"The name change is complete.","components":[{"type":"info_panel"},{"type":"document_viewer"},{"type":"chat"}]}$j$)
  ) AS v(stage_name, waiting_on, client_label, client_label_it, client_description, stage_description, layout)
 WHERE ps.service_type = 'Company Change Name' AND ps.stage_name = v.stage_name;

-- 5. The jobs' stored step name + number ------------------------------------------------------------------------------------------
-- (a job already COMPLETED at the old last step is finished: it goes to "Completed", not back into an open step)
UPDATE public.service_deliveries
   SET stage = 'Completed', stage_order = 8
 WHERE service_type = 'Company Change Name' AND stage = 'Form Change Name received from the SoS' AND status = 'completed';
UPDATE public.service_deliveries sd
   SET stage = m.new_stage, stage_order = m.new_order
  FROM (VALUES
    ('Inform Client name available',            'Check names and client confirms', 2),
    ('File the change name form',               'File the form with the state',    4),
    ('Ship change name form to teh SoS',        'Waiting for the state',           5),
    ('Form Change Name received from the SoS',  'Update our records',              6)
  ) AS m(old_stage, new_stage, new_order)
 WHERE sd.service_type = 'Company Change Name' AND sd.stage = m.old_stage;
UPDATE public.service_deliveries SET stage_order = 1
 WHERE service_type = 'Company Change Name' AND stage = 'Collect three company names' AND stage_order IS DISTINCT FROM 1;

-- "needs a document before moving on" is switched on AFTER the jobs are re-keyed (the database rule would otherwise look at the move)
UPDATE public.pipeline_stages SET requires_document_to_advance = (stage_name = 'Waiting for the state')
 WHERE service_type = 'Company Change Name';

-- 6. The old workflow card: the Calendar is the to-do ------------------------------------------------------------------------------
UPDATE public.tasks
   SET status = 'Cancelled',
       notes  = COALESCE(notes || E'\n', '') || '2026-10-19: card retired — a name change now has its own workspace steps; the Calendar is the to-do (dev job bb64c417).',
       updated_at = now()
 WHERE workflow_slug = 'company_change_name_workflow' AND status NOT IN ('Done', 'Cancelled');

DO $do$
DECLARE
  v_id uuid;
  v_status text;
BEGIN
  SELECT id, status INTO v_id, v_status FROM public.catalog_entries WHERE catalog_id = 'task_workflows' AND slug = 'company_change_name_workflow';
  IF v_id IS NULL THEN
    RAISE NOTICE 'change-name-8-steps: workflow company_change_name_workflow does not exist here (the sandbox never had it) — nothing to retire';
  ELSIF v_status IS DISTINCT FROM 'draft' THEN
    UPDATE public.catalog_entries SET status = 'draft', updated_at = now() WHERE id = v_id;
    INSERT INTO public.catalog_decision_log (catalog_entry_id, catalog_id, action, actor_kind, reason, before_state, after_state)
    VALUES (v_id, 'task_workflows', 'metadata_changed', 'migration',
            'Company Change Name: the workflow card is retired — the service now has 8 workspace steps and the Calendar is the to-do (dev job bb64c417)',
            jsonb_build_object('slug', 'company_change_name_workflow', 'status', v_status),
            jsonb_build_object('slug', 'company_change_name_workflow', 'status', 'draft'));
  END IF;
END
$do$;

-- 6b. The state's stamped document is client-visible (catalog twin of CLIENT_SAFE_FLOW_DOC_STAGES; skipped where that catalog is absent)
INSERT INTO public.catalog_entries (catalog_id, slug, display_name, status, metadata)
SELECT 'storage_client_safe_stages', 'company_change_name', 'Company Change Name', 'active',
       '{"service_type":"Company Change Name","stages":["Waiting for the state"]}'::jsonb
 WHERE EXISTS (SELECT 1 FROM public.catalog_definitions WHERE id = 'storage_client_safe_stages')
   AND NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'storage_client_safe_stages' AND slug = 'company_change_name');

-- 7. Check the result: refuse to commit anything that does not look exactly as intended -------------------------------------------
DO $do$
DECLARE
  v_list text;
BEGIN
  SELECT string_agg(stage_order || ':' || stage_name, ',' ORDER BY stage_order) INTO v_list
    FROM public.pipeline_stages WHERE service_type = 'Company Change Name';
  IF v_list IS DISTINCT FROM '1:Collect three company names,2:Check names and client confirms,3:Client signs the name-change form,4:File the form with the state,5:Waiting for the state,6:Update our records,7:Client updates the Operating Agreement,8:Completed' THEN
    RAISE EXCEPTION 'change-name-8-steps: unexpected step list after the change: %', v_list;
  END IF;
  IF (SELECT count(*) FROM public.pipeline_stages WHERE service_type = 'Company Change Name' AND completes_service) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Change Name' AND stage_name = 'Completed' AND completes_service AND NOT client_visible) THEN
    RAISE EXCEPTION 'change-name-8-steps: "Completed" must be the one and only finishing step';
  END IF;
  IF (SELECT string_agg(waiting_on, ',' ORDER BY stage_order) FROM public.pipeline_stages WHERE service_type = 'Company Change Name')
       IS DISTINCT FROM 'client,us,client,us,outside,us,client,none' THEN
    RAISE EXCEPTION 'change-name-8-steps: whose-turn settings are not as intended';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Change Name' AND (stage_layout IS NULL OR client_label IS NULL OR client_label_it IS NULL OR client_description IS NULL))
     OR (SELECT count(*) FROM public.pipeline_stages WHERE service_type = 'Company Change Name' AND requires_document_to_advance) <> 1 THEN
    RAISE EXCEPTION 'change-name-8-steps: a step is missing its layout / wording, or the document rule is wrong';
  END IF;
  IF EXISTS (SELECT 1 FROM public.service_deliveries sd
              WHERE sd.service_type = 'Company Change Name'
                AND NOT EXISTS (SELECT 1 FROM public.pipeline_stages ps
                                 WHERE ps.service_type = 'Company Change Name' AND ps.stage_name = sd.stage AND ps.stage_order = sd.stage_order)) THEN
    RAISE EXCEPTION 'change-name-8-steps: some name-change job still carries an old step name or number';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tasks WHERE workflow_slug = 'company_change_name_workflow' AND status NOT IN ('Done', 'Cancelled')) THEN
    RAISE EXCEPTION 'change-name-8-steps: an open workflow card is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'task_workflows' AND slug = 'company_change_name_workflow' AND status <> 'draft') THEN
    RAISE EXCEPTION 'change-name-8-steps: the workflow is not a draft';
  END IF;
  IF EXISTS (SELECT 1 FROM public.catalog_definitions WHERE id = 'storage_client_safe_stages')
     AND NOT EXISTS (SELECT 1 FROM public.catalog_entries WHERE catalog_id = 'storage_client_safe_stages' AND slug = 'company_change_name'
                        AND status = 'active' AND metadata -> 'stages' = '["Waiting for the state"]'::jsonb) THEN
    RAISE EXCEPTION 'change-name-8-steps: the client-visible-stage row is missing';
  END IF;
END
$do$;

COMMIT;

SELECT 'change-name-8-steps applied' AS result,
       (SELECT string_agg(stage_order || ':' || stage_name, ' | ' ORDER BY stage_order) FROM public.pipeline_stages WHERE service_type = 'Company Change Name') AS steps,
       (SELECT count(*) FROM public.service_deliveries WHERE service_type = 'Company Change Name') AS jobs_rekeyed;
