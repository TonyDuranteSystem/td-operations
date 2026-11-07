-- Company Closure: the steps no longer create plain to-do cards (Company Closure Part C, dev job a6bbea09; Antonio 2026-11-06: "everything happens in the Calendar").
--
-- WHY: every step of the closure had a list of to-dos that are created each time a job ENTERS the step (pipeline_stages.auto_tasks) — 2 + 3 + 5 + 5 + 5 of them,
--   ~20 plain cards per closure, none of them closed by the work (the workspace screens do that work now: the wizard, the document locks, the tracking number, the IRS
--   letter). They piled up as "To Do" and were all marked Done in one sweep when the company closed. They also included "Notify client that closure is complete" although
--   Antonio decided there is no closing e-mail. The Calendar row of the job (the closure_progress card) stays and is the one place the job lives.
-- WHAT: auto_tasks of the six Company Closure steps is set to an empty list. Nothing else. The follow-up to-dos created when the company is CLOSED are code
--   (lib/services/closure-cascade.ts: the Registered Agent on Harbor, and the lease only when there is one).
-- Re-runnable (only touches a step that still has to-dos). UNDO: 20261107-0100-closure-no-stage-todos.UNDO.sql puts back exactly the lists production had on 2026-11-06.
-- Written for production's shape (read back read-only on 2026-11-06). Apply to SANDBOX first (node scripts/apply-migration.js); production only on Antonio's word.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"closure-no-stage-todos-migration"}', true);

DO $do$
DECLARE
  v_changed int;
  v_left int;
BEGIN
  UPDATE public.pipeline_stages
     SET auto_tasks = '[]'::jsonb
   WHERE service_type = 'Company Closure'
     AND stage_name IN ('Data Collection', 'State Compliance Check', 'State Dissolution Filing', 'IRS Closure', 'Closing')
     AND auto_tasks IS DISTINCT FROM '[]'::jsonb;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RAISE NOTICE 'closure-no-stage-todos: % step(s) cleared', v_changed;

  SELECT count(*) INTO v_left FROM public.pipeline_stages
   WHERE service_type = 'Company Closure' AND auto_tasks IS DISTINCT FROM '[]'::jsonb;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'closure-no-stage-todos: % Company Closure step(s) still have to-dos', v_left;
  END IF;
END
$do$;

COMMIT;
