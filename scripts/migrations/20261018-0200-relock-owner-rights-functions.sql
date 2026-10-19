-- URGENT SECURITY FIX (2026-10-18, dev job 0d934aba / 9aec66fa). SANDBOX FIRST, then production by hand.
-- WHAT WENT WRONG: 20261018-0050 (run on production on 2026-10-18) ended each owner-rights (SECURITY DEFINER) function with
--   GRANT EXECUTE ... TO authenticated, service_role
-- which GAVE EVERY LOGGED-IN USER (all portal clients included) the right to call functions that earlier migrations had
-- deliberately locked to the service key. The worst one is exec_sql(text): it runs ANY SQL it is handed as the database owner.
-- Found by the independent review; confirmed on production (read only): 59 owner-rights functions, all executable by `authenticated`.
-- WHAT THIS DOES: puts back exactly what earlier migrations set (REVOKE ... FROM PUBLIC, anon, authenticated; service key only)
-- for the functions that must never be called by a logged-in browser session. Every caller found in the code uses the SERVICE key.
-- It does not touch the functions a logged-in session may genuinely use (comm_can_read, get_client_account_ids, get_client_contact_id,
-- get_document_type_names, get_portal_chat_threads*, store_staging_upload_allowed, toggle_message_reaction, increment_*): those are a follow-up.
-- Idempotent. Undo: 20261018-0200-relock-owner-rights-functions.UNDO.sql (re-opens them: do NOT run it unless something broke).
DO $$
DECLARE fn record;
BEGIN
  -- service key only
  FOR fn IN
    SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = ANY (ARRAY[
      'exec_sql','exec_sql_readonly',
      'admin_change_company_suite','admin_delete_lease','allocate_company_suite','assign_specific_company_suite','claim_company_suite',
      'issue_delivery_suite','release_company_suite_if_free','release_ended_suites','release_suite_reservation','suite_step_state',
      'unwaive_delivery_suite','waive_delivery_suite',
      'internal_threads_overview','store_orphan_objects','store_purge_pending_objects',
      'get_team_threads','list_all_threads','list_later_threads','list_followed_unread_threads','search_team_messages',
      'toggle_internal_message_reaction','delete_thread_if_sole_author',
      'viewas_restore_auth_stamps','viewas_restore_last_sign_in','onboarding_phase1','submit_member_info','submit_member_info_v2','reset_tool_counter',
      -- trigger functions: nobody calls them directly (a trigger fires whatever its function's grants say)
      'store_formation_status_follow','emit_jobs_ui_event','record_service_settings_change','log_account_status_change','shadow_ingest_trigger',
      'trg_accounts_suite_release_on_close','trg_delivery_document_to_advance','trg_delivery_renewal_close_guard','trg_delivery_suite_step_guard','trg_tax_returns_audit'
    ]) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
  -- internal helpers: nobody but the owner (the public wrappers run as the owner and call them)
  FOR fn IN
    SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = ANY (ARRAY[
      '_admin_change_company_suite_impl','_admin_delete_lease_impl','_allocate_company_suite_impl','_assign_specific_company_suite_impl',
      '_claim_company_suite_impl','_release_company_suite_impl','_suite_to_pool'
    ]) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn.sig);
  END LOOP;
END $$;
