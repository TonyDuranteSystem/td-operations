-- UNDO for 20261016-1500-jobs-live-event.sql: removes the three triggers and the function. Nothing else depends on them; the Calendar keeps
-- refreshing every minute and when you return to the tab. Old 'jobs' rows in ui_events are harmless (nothing else reads that kind).
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS trg_service_deliveries_ui_event_del ON public.service_deliveries;
DROP TRIGGER IF EXISTS trg_service_deliveries_ui_event_upd ON public.service_deliveries;
DROP TRIGGER IF EXISTS trg_service_deliveries_ui_event_ins ON public.service_deliveries;
DROP FUNCTION IF EXISTS public.emit_jobs_ui_event();
COMMIT;
