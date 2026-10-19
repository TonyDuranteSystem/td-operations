-- Undo for 20261018-0210: gives logged-in users EXECUTE back on the nine functions (re-opens the cross-client chat read). Diagnose only.
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = ANY (ARRAY[
      'get_portal_chat_threads','get_portal_chat_threads_unified','get_portal_chat_threads_v2','toggle_message_reaction',
      'increment_email_open','increment_message_count','increment_oa_signed_count','increment_tool_counter','get_document_type_names'
    ]) LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn.sig);
  END LOOP;
END $$;
