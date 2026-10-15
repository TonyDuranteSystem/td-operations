-- UNDO for 20261015-1600-closure-wrapup-panel.sql (dev job 5b136702): put the three step to-dos and the old step text back and remove the panel layout.
-- Touches only the Company Closure "Wrap-up" step, and only the three fields the migration set; it leaves anything else as it is.
-- To-dos already created on jobs are not touched by the migration and are not touched here.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"closure-wrapup-panel-undo"}', true);

UPDATE public.pipeline_stages
   SET auto_tasks = $j$[
         {"title": "Cancel Registered Agent on Harbor Compliance", "category": "Filing", "assigned_to": "Luca"},
         {"title": "Cancel CMRA/lease if active", "category": "Filing", "assigned_to": "Luca"},
         {"title": "Stop the yearly renewals (RA + annual report) and clear their dates", "category": "CRM Update", "assigned_to": "Luca"}
       ]$j$::jsonb
 WHERE service_type = 'Company Closure' AND stage_name = 'Wrap-up' AND auto_tasks = '[]'::jsonb;

UPDATE public.pipeline_stages
   SET stage_layout = NULL
 WHERE service_type = 'Company Closure' AND stage_name = 'Wrap-up'
   AND stage_layout = '{"components":[{"type":"info_panel"},{"type":"closure_wrapup"}]}'::jsonb;

UPDATE public.pipeline_stages
   SET stage_description = 'The state and IRS filings are done. Now cancel what we still run for this company: the Registered Agent on Harbor Compliance, the CMRA mailing address / lease if the company has one, and the yearly renewals. When all three are done press "Wrap-up done" — that closes the company in the CRM (account Closed, portal off, open services cancelled) and tells the client.'
 WHERE service_type = 'Company Closure' AND stage_name = 'Wrap-up'
   AND stage_description LIKE 'The state and IRS filings are done. Use the panel below:%';

COMMIT;
