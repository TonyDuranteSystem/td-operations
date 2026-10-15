-- Company Closure: a new "Wrap-up" step (ours) in front of the finishing step "Closing" — dev job be7da01a (N1a), Antonio 2026-10-15.
--
-- WHY: the new Operations Calendar builds Luca's "on us" list from each job's CURRENT STEP. "Closing" is the finishing
--   step, so a closure job completes the moment it gets there — and the chores that go with closing a company (cancel the
--   Registered Agent on Harbor, cancel the CMRA mailing address / lease, stop the yearly renewals) had no Calendar line.
--   Now they live on "Wrap-up", an ordinary step that is ours, and the button that finishes it ("Wrap-up done") is what
--   closes the company.
--
-- WHAT (Company Closure only — Company Formation also has a step called "Closing" and is NOT touched):
--   1. pipeline_stages: "Closing" moves from 5 to 6, "Wrap-up" is inserted at 5 (ours, NOT the finishing step,
--      auto_advance OFF so ticking its last chore can never finish the job behind the closing actions' back, its own
--      client-safe text — nothing client-facing is copied from "Closing"). The three chores move from "Closing"
--      (where they were created and instantly closed as Done) to "Wrap-up"; "Closing" keeps no step to-dos.
--   2. service_deliveries: closure jobs keep their own copy of the step number, so jobs on "Closing" are re-synced to 6.
--   3. Workflow closure_progress (catalog_entries): the "IRS Closure complete" button now goes to Wrap-up (all four
--      places that said "Closing" are updated) and a new button "Wrap-up done -> Close the company" goes to Closing.
--   4. The pinned copy of the workflow on OPEN closure to-do cards is refreshed so cards already on the board get the
--      new buttons (catalog edits never reach pinned copies on their own).
-- Re-runnable: every part checks before it acts. UNDO: 20261015-1200-closure-wrapup-step.UNDO.sql (refuses while any job
--   sits on Wrap-up). Apply to SANDBOX first (node scripts/apply-migration.js); production only on Antonio's word.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"closure-wrapup-migration"}', true);

-- 1 + 2. Steps and the jobs' stored step number -------------------------------------------------------------------
DO $do$
DECLARE
  v_closing_order int;
  v_closing_done  boolean;
  v_max_order     int;
  v_entry         uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'Wrap-up') THEN
    RAISE NOTICE 'closure-wrapup: Wrap-up step already present — skipping the step part';
  ELSE
    SELECT stage_order, completes_service, service_type_entry_id
      INTO v_closing_order, v_closing_done, v_entry
      FROM public.pipeline_stages
     WHERE service_type = 'Company Closure' AND stage_name = 'Closing'
       FOR UPDATE;
    SELECT max(stage_order) INTO v_max_order FROM public.pipeline_stages WHERE service_type = 'Company Closure';

    IF v_closing_order IS NULL THEN
      RAISE EXCEPTION 'closure-wrapup: no "Closing" step found for Company Closure — nothing changed';
    END IF;
    IF v_closing_order IS DISTINCT FROM v_max_order OR v_closing_done IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'closure-wrapup: "Closing" is expected to be the LAST step and the finishing step (order %, finishing %, last %) — nothing changed',
        v_closing_order, v_closing_done, v_max_order;
    END IF;

    -- "Closing" is the last step, so the number just above it is free.
    UPDATE public.pipeline_stages
       SET stage_order = v_closing_order + 1,
           stage_description = 'Automatic: the company is closed in the CRM (account Closed, portal off, open services cancelled), the client is told, and any Wrap-up chore not yet done becomes a follow-up to-do. Move a job here only after Wrap-up is complete.',
           auto_tasks = '[]'::jsonb
     WHERE service_type = 'Company Closure' AND stage_name = 'Closing';

    INSERT INTO public.pipeline_stages
      (service_type, stage_order, stage_name, stage_description, client_description, auto_tasks, auto_actions,
       sla_days, requires_approval, auto_advance, waiting_on, completes_service, requires_document_to_advance,
       notify_client_email, notify_client_chat, client_visible, board_visible, tracking_check_enabled, service_type_entry_id)
    VALUES
      ('Company Closure', v_closing_order, 'Wrap-up',
       'The state and IRS filings are done. Now cancel what we still run for this company: the Registered Agent on Harbor Compliance, the CMRA mailing address / lease if the company has one, and the yearly renewals. When all three are done press "Wrap-up done" — that closes the company in the CRM (account Closed, portal off, open services cancelled) and tells the client.',
       'We are ending the services we ran for your company and getting ready to close your file.',
       $j$[
         {"title": "Cancel Registered Agent on Harbor Compliance", "category": "Filing", "assigned_to": "Luca"},
         {"title": "Cancel CMRA/lease if active", "category": "Filing", "assigned_to": "Luca"},
         {"title": "Stop the yearly renewals (RA + annual report) and clear their dates", "category": "CRM Update", "assigned_to": "Luca"}
       ]$j$::jsonb,
       '[]'::jsonb,
       5, false, false, 'us', false, false,
       false, false, true, true, false, v_entry);
  END IF;

  -- Jobs keep their own copy of the step number: bring every closure job's number in line with the step list (by name).
  UPDATE public.service_deliveries sd
     SET stage_order = ps.stage_order
    FROM public.pipeline_stages ps
   WHERE sd.service_type = 'Company Closure' AND ps.service_type = 'Company Closure' AND ps.stage_name = sd.stage
     AND sd.stage_order IS DISTINCT FROM ps.stage_order;
END
$do$;

-- 3 + 4. Workflow buttons and the pinned copies on open cards ---------------------------------------------------------
DO $do$
DECLARE
  v_wf_id   uuid;
  v_before  jsonb;
  v_meta    jsonb;
  v_actions jsonb;
  v_new     jsonb;
  v_pos     int;
  v_changed boolean := false;
BEGIN
  SELECT id, metadata INTO v_wf_id, v_before
    FROM public.catalog_entries
   WHERE catalog_id = 'task_workflows' AND slug = 'closure_progress'
     FOR UPDATE;
  IF v_wf_id IS NULL THEN
    RAISE EXCEPTION 'closure-wrapup: workflow closure_progress not found — nothing changed';
  END IF;
  v_actions := v_before -> 'actions';

  -- Retarget the IRS button (all four places that said "Closing").
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_actions) a
              WHERE a ->> 'slug' = 'confirm_irs_closure' AND a #>> '{handler_params,target_stage}' IS DISTINCT FROM 'Wrap-up') THEN
    SELECT jsonb_agg(
             CASE WHEN a ->> 'slug' = 'confirm_irs_closure' THEN
               jsonb_set(jsonb_set(jsonb_set(jsonb_set(a,
                 '{handler_params,target_stage}', '"Wrap-up"'::jsonb),
                 '{label_admin}', '"IRS Closure Complete → Wrap-up"'::jsonb),
                 '{confirm,summary}', '"Confirm IRS final filings complete and advance to Wrap-up?"'::jsonb),
                 '{on_success_meta,workflow_state}', '"Wrap-up"'::jsonb)
             ELSE a END ORDER BY ord)
      INTO v_actions
      FROM jsonb_array_elements(v_actions) WITH ORDINALITY AS t(a, ord);
    v_changed := true;
  END IF;

  -- Add the "Wrap-up done" button right after it (matched by slug, never added twice).
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_actions) a WHERE a ->> 'slug' = 'confirm_wrapup_done') THEN
    v_new := $j${
      "icon": "CheckCircle2",
      "slug": "confirm_wrapup_done",
      "color": "green",
      "confirm": {"summary": "Confirm the Registered Agent, the CMRA/lease and the yearly renewals are all cancelled? Pressing this CLOSES the company: the account is set to Closed, the portal is turned off and the open services are cancelled."},
      "handler": "chain.advance_sd_stage",
      "permission": {"role_in": ["admin", "team"]},
      "label_admin": "Wrap-up Done → Close the company",
      "visible_when": {"sd_stage": "Wrap-up"},
      "handler_params": {"target_stage": "Closing"},
      "on_success_meta": {"workflow_state": "Closing"},
      "on_success_status": "Done"
    }$j$::jsonb;
    SELECT ord INTO v_pos FROM jsonb_array_elements(v_actions) WITH ORDINALITY AS t(a, ord) WHERE a ->> 'slug' = 'confirm_irs_closure';
    IF v_pos IS NULL THEN
      RAISE EXCEPTION 'closure-wrapup: button confirm_irs_closure not found — nothing changed';
    END IF;
    SELECT jsonb_agg(x ORDER BY o) INTO v_actions FROM (
      SELECT a AS x, ord * 2 AS o FROM jsonb_array_elements(v_actions) WITH ORDINALITY AS t(a, ord)
      UNION ALL SELECT v_new, v_pos * 2 + 1
    ) s;
    v_changed := true;
  END IF;

  IF v_changed THEN
    v_meta := jsonb_set(v_before, '{actions}', v_actions);
    UPDATE public.catalog_entries SET metadata = v_meta, updated_at = now() WHERE id = v_wf_id;
    INSERT INTO public.catalog_decision_log (catalog_entry_id, catalog_id, action, actor_kind, reason, before_state, after_state)
    VALUES (v_wf_id, 'task_workflows', 'metadata_changed', 'migration',
            'Company Closure: new Wrap-up step — IRS button now goes to Wrap-up, new Wrap-up done button goes to Closing (dev job be7da01a)',
            jsonb_build_object('slug', 'closure_progress', 'actions', (SELECT jsonb_agg(a ->> 'slug') FROM jsonb_array_elements(v_before -> 'actions') a)),
            jsonb_build_object('slug', 'closure_progress', 'actions', (SELECT jsonb_agg(a ->> 'slug') FROM jsonb_array_elements(v_actions) a)));
  ELSE
    RAISE NOTICE 'closure-wrapup: workflow buttons already up to date';
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

-- Check the result: refuse to commit anything that does not look exactly as intended -------------------------------------
DO $do$
DECLARE
  v_list text;
  v_irs   text;
  v_wrap  text;
BEGIN
  SELECT string_agg(stage_order || ':' || stage_name, ',' ORDER BY stage_order) INTO v_list
    FROM public.pipeline_stages WHERE service_type = 'Company Closure';
  IF v_list IS DISTINCT FROM '1:Data Collection,2:State Compliance Check,3:State Dissolution Filing,4:IRS Closure,5:Wrap-up,6:Closing' THEN
    RAISE EXCEPTION 'closure-wrapup: unexpected step list after the change: %', v_list;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'Wrap-up'
                   AND waiting_on = 'us' AND completes_service = false AND auto_advance = false AND stage_order = 5)
     OR NOT EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'Closing'
                   AND completes_service = true AND stage_order = 6) THEN
    RAISE EXCEPTION 'closure-wrapup: Wrap-up / Closing settings are not as intended';
  END IF;
  IF EXISTS (SELECT 1 FROM public.service_deliveries sd JOIN public.pipeline_stages ps
               ON ps.service_type = 'Company Closure' AND ps.stage_name = sd.stage
              WHERE sd.service_type = 'Company Closure' AND sd.stage_order IS DISTINCT FROM ps.stage_order) THEN
    RAISE EXCEPTION 'closure-wrapup: some closure jobs still carry an old step number';
  END IF;
  SELECT a #>> '{handler_params,target_stage}' INTO v_irs
    FROM public.catalog_entries ce, jsonb_array_elements(ce.metadata -> 'actions') a
   WHERE ce.catalog_id = 'task_workflows' AND ce.slug = 'closure_progress' AND a ->> 'slug' = 'confirm_irs_closure';
  SELECT a #>> '{handler_params,target_stage}' INTO v_wrap
    FROM public.catalog_entries ce, jsonb_array_elements(ce.metadata -> 'actions') a
   WHERE ce.catalog_id = 'task_workflows' AND ce.slug = 'closure_progress' AND a ->> 'slug' = 'confirm_wrapup_done';
  IF v_irs IS DISTINCT FROM 'Wrap-up' OR v_wrap IS DISTINCT FROM 'Closing' THEN
    RAISE EXCEPTION 'closure-wrapup: workflow buttons are not as intended (irs=%, wrapup=%)', v_irs, v_wrap;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tasks WHERE workflow_slug = 'closure_progress' AND status NOT IN ('Done', 'Cancelled')
               AND NOT (workflow_snapshot -> 'actions') @> '[{"slug": "confirm_wrapup_done"}]'::jsonb) THEN
    RAISE EXCEPTION 'closure-wrapup: some open closure cards did not get the new button';
  END IF;
END
$do$;

COMMIT;
