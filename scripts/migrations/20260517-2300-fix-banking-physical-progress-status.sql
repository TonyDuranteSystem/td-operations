-- Fix latent catalog bug caught by `scripts/check-catalog-validity.ts`.
--
-- `banking_physical_progress` actions[0] (Scheduling Done → Application
-- Prepared) and actions[1] (Documents Received → Bank Visit) were missing
-- the Zod-required `on_success_status` field. If a Luca ever clicked one of
-- these buttons, `parseWorkflowSnapshot(task.workflow_snapshot)` in the
-- action route (line 137 of app/api/tasks/[id]/action/route.ts) would throw
-- and the action would return 400 "Corrupt workflow_snapshot on task" with
-- no recourse. Today the workflow is dormant (0 tasks, no chain.spawn_
-- next_workflow references it) — so this bug never fired — but it would
-- ship to production and explode the moment someone wired it up.
--
-- Both intermediate actions get `on_success_status: "In Progress"` (the
-- task stays alive so the next stage's button can be clicked on the same
-- task — same pattern as formation_progress / closure_progress / onboarding_
-- progress whose intermediate actions also leave the task open). The final
-- action (`confirm_visit_done`, actions[2]) already has `on_success_status:
-- "Done"` from the original Slice 8 Pass 6 migration.
--
-- Idempotent: jsonb_set with create_missing=true rewrites the field to the
-- same value on re-run.

BEGIN;

UPDATE catalog_entries
SET metadata = jsonb_set(
  jsonb_set(metadata, '{actions,0,on_success_status}', '"In Progress"'::jsonb, true),
  '{actions,1,on_success_status}',
  '"In Progress"'::jsonb,
  true
)
WHERE catalog_id = 'task_workflows' AND slug = 'banking_physical_progress';

COMMIT;
