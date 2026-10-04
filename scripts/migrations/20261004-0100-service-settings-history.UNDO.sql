-- UNDO for 20261004-0100-service-settings-history.sql. Drops the recorder and the history table (the history is lost).
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS trg_service_settings_history_stages ON public.pipeline_stages;
DROP TRIGGER IF EXISTS trg_service_settings_history_cards_ins ON public.catalog_entries;
DROP TRIGGER IF EXISTS trg_service_settings_history_cards_upd ON public.catalog_entries;
DROP TRIGGER IF EXISTS trg_service_settings_history_cards_del ON public.catalog_entries;
DROP FUNCTION IF EXISTS public.record_service_settings_change();
DROP TABLE IF EXISTS public.service_settings_history;
COMMIT;
