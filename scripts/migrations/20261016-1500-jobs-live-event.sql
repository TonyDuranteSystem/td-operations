-- The Calendar updates by itself (dev job 40235e3c, Antonio 2026-10-16: "the page should refresh automatically and right away when we do something").
--
-- A step move / a finished job / a new job writes ONE row to the live-update bus (ui_events, kind 'jobs'); the dashboard listens to that bus
-- (Supabase Realtime, staff only) and the Calendar re-renders about a second later. Done as a DATABASE TRIGGER on service_deliveries so EVERY
-- writer is covered (the workspace, MCP tools, webhooks, crons, SQL) instead of only the code paths someone remembers to wire.
--
--   * STATEMENT-level: a bulk update (100 jobs in one statement) is ONE event, not 100;
--   * fires only when something the Calendar shows changes (step, status, step date, end date, test flag, owner) or a job is created;
--   * SAFE BY CONSTRUCTION: the signal is wrapped so that ANY failure (a missing table, a permission) is swallowed — it can never block or roll
--     back a job write;
--   * payload NULL: the event carries no client data;
--   * no schema change to ui_events (its kind is free text and it already feeds Realtime for staff).
-- Safe before OR after the code: until it exists the Calendar still refreshes every minute and when you return to the tab.
-- UNDO: 20261016-1500-jobs-live-event.UNDO.sql

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.emit_jobs_ui_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    INSERT INTO public.ui_events (kind, payload) VALUES ('jobs', NULL);
  EXCEPTION WHEN OTHERS THEN
    NULL; -- a live-update signal must never block a job write
  END;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_service_deliveries_ui_event_ins ON public.service_deliveries;
CREATE TRIGGER trg_service_deliveries_ui_event_ins
  AFTER INSERT ON public.service_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION public.emit_jobs_ui_event();

DROP TRIGGER IF EXISTS trg_service_deliveries_ui_event_upd ON public.service_deliveries;
CREATE TRIGGER trg_service_deliveries_ui_event_upd
  AFTER UPDATE OF stage, status, stage_entered_at, end_date, is_test, account_id, contact_id ON public.service_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION public.emit_jobs_ui_event();

COMMIT;
