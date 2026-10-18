-- SECURITY (found 2026-10-17/18 while planning TD Marketing P1, dev job 9aec66fa). SANDBOX FIRST, then production by hand.
-- WHAT WAS FOUND, on production, with the PUBLIC key that the website itself ships to every browser (counts only, no data read):
--   * the anonymous role holds SELECT/INSERT/UPDATE/DELETE on ~218 public tables; row-level security is the only thing in the way;
--   * 25 of them had row-level security OFF (session_checkpoints, system_docs, agent_memory, app_settings, catalog_entries ...) —
--     readable AND writable by anyone (system_docs returned all 176 rows to the anonymous key);
--   * some tables whose policies say "any role that is not 'client'" (wizard_progress 256 rows, email_links 51, internal_thread_*,
--     signature_requests) also match an ANONYMOUS caller, because an anonymous token carries no role at all;
--   * 101 database functions are callable by anonymous; 25 of them run with the owner's rights, among them get_team_threads,
--     list_all_threads, search_team_messages (they take a user id as an argument), toggle_internal_message_reaction,
--     delete_thread_if_sole_author, onboarding_phase1, submit_member_info, viewas_restore_*.
-- WHAT THIS DOES (evidence-based, using the project's own anon contract: tests/unit/anon-grant-contract.test.ts says the browser
-- needs exactly: form_8832_applications SELECT+UPDATE, signature_requests SELECT+UPDATE, member_info_requests SELECT):
--   1. takes every privilege on every public table away from `anon`, except those three grants;
--   2. stops future tables from being handed to `anon` automatically;
--   3. takes EXECUTE on every owner-rights function away from PUBLIC and `anon` (authenticated and service_role keep it for now);
--      every caller found in the code uses the SERVICE key, which is unaffected.
-- Undo: 20261018-0050-security-lock-anonymous-access.UNDO.sql (gives the old grants back). Idempotent.
DO $$
DECLARE r record; fn record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', r.relname);
  END LOOP;
  IF to_regclass('public.form_8832_applications') IS NOT NULL THEN GRANT SELECT, UPDATE ON public.form_8832_applications TO anon; END IF;
  IF to_regclass('public.signature_requests')      IS NOT NULL THEN GRANT SELECT, UPDATE ON public.signature_requests      TO anon; END IF;
  IF to_regclass('public.member_info_requests')    IS NOT NULL THEN GRANT SELECT          ON public.member_info_requests    TO anon; END IF;

  -- every function that runs with the OWNER's rights (SECURITY DEFINER): not callable by anonymous or PUBLIC.
  -- (On production these are the 25 listed above; the sandbox also had exec_sql(text), which runs any SQL it is given.)
  FOR fn IN SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn.sig);
  END LOOP;
END $$;
-- new tables and functions created later must not be handed to anonymous automatically
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
