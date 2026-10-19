-- Undo: switch row-level security back OFF on the sixteen tables (this re-opens them to anyone with the public key).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'session_checkpoints','decision_memory','agent_decisions','system_docs','irs_exchange_rates','zoho_templates',
    'dashboard_project','catalog_pending_review','mcp_tool_counter','partner_client_deals','document_types','agent_memory',
    'client_credit_notes','catalog_decision_log','compliance_requirements','partner_client_services'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;
