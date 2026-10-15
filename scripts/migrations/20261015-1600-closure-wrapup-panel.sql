-- Company Closure "Wrap-up" step: show the read-only Wrap-up panel and stop creating the three step to-dos
-- — dev job 5b136702 (slice 1 of the Wrap-up pop-up, child of be7da01a), Antonio 2026-10-15.
--
-- WHY: Antonio's standing rule is "no CRM to-do cards for humans": the Calendar step IS the to-do. The Wrap-up step created three
--   Luca to-do cards (cancel Harbor, cancel CMRA/lease, stop renewals) that nothing closed. They are replaced by one panel on the
--   job's workspace page (stage_layout component "closure_wrapup") that shows everything the person needs. Later slices turn the
--   panel into the decision pop-up.
--
-- WHAT (Company Closure -> "Wrap-up" only):
--   1. pipeline_stages.auto_tasks = [] (no step to-dos are created any more for jobs that ENTER the step from now on; to-dos already
--      created on jobs at the step are left alone).
--   2. pipeline_stages.stage_layout = {"components":[{"type":"info_panel"},{"type":"closure_wrapup"}]} (the usual overview, then the panel).
--   3. pipeline_stages.stage_description: no longer tells staff to do three chores that have no to-do any more; it points at the panel.
--
-- ORDER (turn-on on production, only on Antonio's word): 20261015-1200-closure-wrapup-step.sql, THEN this file. The CODE that knows
--   the "closure_wrapup" component must be deployed BEFORE this runs (the layout parser drops unknown component types, so the
--   workspace would otherwise fall back to the empty default).
-- Re-runnable: it only writes when something differs. UNDO: 20261015-1600-closure-wrapup-panel.UNDO.sql.
-- Apply to SANDBOX first (node scripts/apply-migration.js <file>).

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"closure-wrapup-panel-migration"}', true);

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pipeline_stages WHERE service_type = 'Company Closure' AND stage_name = 'Wrap-up') THEN
    RAISE EXCEPTION 'closure-wrapup-panel: there is no "Wrap-up" step for Company Closure here — run 20261015-1200-closure-wrapup-step.sql first — nothing changed';
  END IF;

  UPDATE public.pipeline_stages
     SET auto_tasks        = '[]'::jsonb,
         stage_layout      = '{"components":[{"type":"info_panel"},{"type":"closure_wrapup"}]}'::jsonb,
         stage_description = 'The state and IRS filings are done. Use the panel below: it shows the registered agent, money, tax return, renewals and other services. When everything is handled, press "Wrap-up done" on the workflow card to close the company (the old way. A pop-up replaces that button in a later version).'
   WHERE service_type = 'Company Closure' AND stage_name = 'Wrap-up'
     AND (auto_tasks IS DISTINCT FROM '[]'::jsonb
          OR stage_layout IS DISTINCT FROM '{"components":[{"type":"info_panel"},{"type":"closure_wrapup"}]}'::jsonb
          OR stage_description NOT LIKE 'The state and IRS filings are done. Use the panel below:%');

  IF NOT EXISTS (
    SELECT 1 FROM public.pipeline_stages
     WHERE service_type = 'Company Closure' AND stage_name = 'Wrap-up'
       AND auto_tasks = '[]'::jsonb
       AND stage_layout = '{"components":[{"type":"info_panel"},{"type":"closure_wrapup"}]}'::jsonb
       AND stage_description LIKE 'The state and IRS filings are done. Use the panel below:%'
  ) THEN
    RAISE EXCEPTION 'closure-wrapup-panel: the Wrap-up step is not in the expected state after the update — nothing changed';
  END IF;
END
$do$;

COMMIT;

-- verify (expect 0 to-dos and the closure_wrapup component):
-- SELECT stage_name, jsonb_array_length(auto_tasks) AS todos, stage_layout FROM pipeline_stages
--  WHERE service_type = 'Company Closure' AND stage_name = 'Wrap-up';
