-- Undo for 20261018-0110-marketing-p1-db-lock.sql. Removes the marketing_blocked policy everywhere, the nine tables' policy,
-- the team-read policies and the two new tables. It does NOT switch row-level security back off (turning it off would
-- re-open tables; do that only deliberately, table by table).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' LOOP
    EXECUTE format('DROP POLICY IF EXISTS marketing_blocked ON public.%I', r.relname);
    EXECUTE format('DROP POLICY IF EXISTS logged_in_not_marketing ON public.%I', r.relname);
  END LOOP;
END $$;
DROP POLICY IF EXISTS marketing_read_own_team ON marketing_teams;
DROP POLICY IF EXISTS marketing_read_team_settings ON marketing_settings;
DROP POLICY IF EXISTS marketing_owner_reads_terms ON marketing_commission_terms;
DROP TABLE IF EXISTS marketing_invites;
DROP TABLE IF EXISTS marketing_team_members;
DROP FUNCTION IF EXISTS public.marketing_my_team_ids();
DROP FUNCTION IF EXISTS public.marketing_my_owner_team_ids();
