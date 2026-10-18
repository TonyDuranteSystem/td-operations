-- Undo for 20261018-0110-marketing-p1-db-lock.sql. UNDO THIS BEFORE undoing 20261017-1900 (the tables below reference marketing_teams).
-- Removes the marketing_blocked policy everywhere, the team-read policies, the two new tables and the lock function.
-- It does NOT switch row-level security back off (that would re-open tables). Tables whose screens read them with the user's own
-- session (the nine that were open before: they carry the permissive policy logged_in_not_marketing) get an equivalent
-- "open to every logged-in token" policy instead, so no screen goes blank after the undo; anonymous access stays closed.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') LOOP
    EXECUTE format('DROP POLICY IF EXISTS marketing_blocked ON public.%I', r.relname);
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = r.relname AND policyname = 'logged_in_not_marketing') THEN
      EXECUTE format('DROP POLICY IF EXISTS logged_in_not_marketing ON public.%I', r.relname);
      EXECUTE format('DROP POLICY IF EXISTS undo_open_to_logged_in ON public.%I', r.relname);
      EXECUTE format('CREATE POLICY undo_open_to_logged_in ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)', r.relname);
    END IF;
  END LOOP;
END $$;
DROP POLICY IF EXISTS marketing_read_own_team ON marketing_teams;
DROP POLICY IF EXISTS marketing_read_team_settings ON marketing_settings;
DROP POLICY IF EXISTS marketing_owner_reads_terms ON marketing_commission_terms;
DROP TABLE IF EXISTS marketing_invites;
DROP TABLE IF EXISTS marketing_team_members;
DROP FUNCTION IF EXISTS public.marketing_my_team_ids();
DROP FUNCTION IF EXISTS public.marketing_my_owner_team_ids();
DROP FUNCTION IF EXISTS public.marketing_lock_all_tables();
