-- SECURITY FOLLOW-UP to 20261018-0200 (2026-10-18, dev job 9aec66fa). SANDBOX FIRST, then production by hand.
-- 0200 took the dangerous owner-rights functions back from logged-in users. These nine were left because they needed a check
-- of who calls them. Checked: every caller in the code uses the SERVICE key (supabaseAdmin / service-role client), and no
-- row-level-security policy mentions any of them. Without this, any logged-in client could call the three chat-thread functions
-- (no arguments, owner rights) and read EVERY client's company names, last chat message and unread counts, and could also
-- add or remove emoji reactions on any client's chat message, and bump counters.
-- NOT touched (a policy or the storage upload rule needs a logged-in session to run them): get_client_account_ids,
-- get_client_contact_id, comm_can_read, store_staging_upload_allowed.
-- Idempotent. Undo: 20261018-0210-relock-remaining-owner-rights-functions.UNDO.sql.
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = ANY (ARRAY[
      'get_portal_chat_threads','get_portal_chat_threads_unified','get_portal_chat_threads_v2','toggle_message_reaction',
      'increment_email_open','increment_message_count','increment_oa_signed_count','increment_tool_counter','get_document_type_names'
    ]) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END $$;
