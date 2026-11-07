-- UNDO for 20261107-0100-closure-no-stage-todos.sql — puts back the to-do lists the six Company Closure steps had on production on 2026-11-06.
-- A step is restored only while its list is still empty (so a list someone edited since is not overwritten).

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"closure-no-stage-todos-undo"}', true);

DO $do$
BEGIN
  UPDATE public.pipeline_stages
     SET auto_tasks = '[{"title": "Send closure data collection form to client", "category": "Client Communication", "assigned_to": "Luca"}, {"title": "Review submitted closure form data", "category": "Document", "assigned_to": "Luca"}]'::jsonb
   WHERE service_type = 'Company Closure' AND stage_name = 'Data Collection' AND auto_tasks = '[]'::jsonb;
  UPDATE public.pipeline_stages
     SET auto_tasks = '[{"title": "Check outstanding state taxes and fees", "category": "Filing", "assigned_to": "Luca"}, {"title": "Verify annual reports are up to date", "category": "Filing", "assigned_to": "Luca"}, {"title": "Resolve any outstanding obligations with the state", "category": "Filing", "assigned_to": "Luca"}]'::jsonb
   WHERE service_type = 'Company Closure' AND stage_name = 'State Compliance Check' AND auto_tasks = '[]'::jsonb;
  UPDATE public.pipeline_stages
     SET auto_tasks = '[{"title": "Fill out Articles of Dissolution form with LLC data", "category": "Document", "assigned_to": "Luca"}, {"title": "Print Articles of Dissolution", "category": "Document", "assigned_to": "Luca"}, {"title": "Prepare shipping label and mail to state", "category": "Shipping", "assigned_to": "Luca"}, {"title": "Save tracking number in CRM", "category": "Filing", "assigned_to": "Luca"}, {"title": "Wait for state confirmation of dissolution", "category": "Filing", "assigned_to": "Luca"}]'::jsonb
   WHERE service_type = 'Company Closure' AND stage_name = 'State Dissolution Filing' AND auto_tasks = '[]'::jsonb;
  UPDATE public.pipeline_stages
     SET auto_tasks = '[{"title": "Fill out EIN closure form", "category": "Document", "assigned_to": "Luca"}, {"title": "If final tax return needed: send data to India team", "category": "Filing", "assigned_to": "Luca"}, {"title": "Print EIN closure form (+ final tax return if applicable)", "category": "Document", "assigned_to": "Luca"}, {"title": "Prepare shipping label and mail to IRS", "category": "Shipping", "assigned_to": "Luca"}, {"title": "Save tracking number in CRM", "category": "Filing", "assigned_to": "Luca"}]'::jsonb
   WHERE service_type = 'Company Closure' AND stage_name = 'IRS Closure' AND auto_tasks = '[]'::jsonb;
  UPDATE public.pipeline_stages
     SET auto_tasks = '[{"title": "Cancel Registered Agent on Harbor Compliance", "category": "Filing", "assigned_to": "Luca"}, {"title": "Cancel CMRA/lease if active", "category": "Filing", "assigned_to": "Luca"}, {"title": "Remove from Annual Renewal pipeline", "category": "CRM Update", "assigned_to": "Luca"}, {"title": "Update account status to Inactive", "category": "CRM Update", "assigned_to": "Luca"}, {"title": "Notify client that closure is complete", "category": "Client Communication", "assigned_to": "Luca"}]'::jsonb
   WHERE service_type = 'Company Closure' AND stage_name = 'Closing' AND auto_tasks = '[]'::jsonb;
END
$do$;

COMMIT;
