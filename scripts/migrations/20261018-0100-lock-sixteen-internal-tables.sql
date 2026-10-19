-- SECURITY (found 2026-10-17 while planning TD Marketing P1, dev job 9aec66fa). SANDBOX FIRST, then production by hand.
-- Sixteen internal tables had row-level security OFF while the public (anonymous) key and every logged-in token could read
-- them. Confirmed on production with the public key shipped in the site code: system_docs returned all 176 rows.
-- Turning row-level security ON with NO policy means: anonymous and logged-in tokens read nothing; the server (service key) is
-- unaffected because it bypasses row-level security. Checked in the code: these sixteen tables are only ever read or written
-- with the service key (or not at all), so no screen depends on a browser or user-session read of them.
-- Idempotent. Undo: 20261018-0100-lock-sixteen-internal-tables.UNDO.sql
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'session_checkpoints','decision_memory','agent_decisions','system_docs','irs_exchange_rates','zoho_templates',
    'dashboard_project','catalog_pending_review','mcp_tool_counter','partner_client_deals','document_types','agent_memory',
    'client_credit_notes','catalog_decision_log','compliance_requirements','partner_client_services'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;
