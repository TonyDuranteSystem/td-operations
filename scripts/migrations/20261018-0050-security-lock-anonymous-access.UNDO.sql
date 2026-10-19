-- Undo for 20261018-0050: gives `anon` its old privileges back on every public table and on the 25 functions.
-- This RE-OPENS the exposure described in the main file. Use only to recover from a broken public page, then fix it properly.
DO $$
DECLARE r record; f text;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') LOOP
    EXECUTE format('GRANT ALL ON TABLE public.%I TO anon', r.relname);
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'comm_can_read(uuid,text,text)','delete_thread_if_sole_author(uuid,uuid)','get_client_account_ids()','get_client_contact_id()',
    'get_document_type_names()','get_portal_chat_threads()','get_portal_chat_threads_unified()','get_portal_chat_threads_v2()',
    'get_team_threads(uuid)','increment_email_open(text)','increment_message_count(uuid)','increment_oa_signed_count(uuid)',
    'list_all_threads(uuid,integer,boolean)','list_followed_unread_threads(uuid)','list_later_threads(uuid)',
    'onboarding_phase1(jsonb,jsonb,uuid,uuid)','reset_tool_counter()','search_team_messages(uuid,text)','shadow_ingest_trigger()',
    'submit_member_info(uuid,jsonb)','toggle_internal_message_reaction(uuid,text,text,text)',
    'toggle_message_reaction(uuid,text,text,text,text)','trg_tax_returns_audit()',
    'viewas_restore_auth_stamps(uuid,timestamptz,timestamptz)','viewas_restore_last_sign_in(uuid,timestamptz)'
  ] LOOP
    IF to_regprocedure('public.' || f) IS NOT NULL THEN EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO PUBLIC, anon', f); END IF;
  END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;
