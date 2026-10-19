-- TD Marketing P1 (dev job 9aec66fa): the database's own locks. SANDBOX FIRST. Run AFTER 20261018-0100 (the sixteen-table lock).
-- RUN ORDER ON PRODUCTION: 20261017-1900-marketing-p0-settings.sql FIRST (this file builds on marketing_teams / marketing_settings and
-- stops with a clear message if they are missing), then THIS file, then 20261018-1900-webhook-events-tagged-payment-unique.sql.
-- A marketing login holds a real token and could talk to the database directly (the REST API), not only through our pages.
-- This file makes sure that token can read NOTHING that is not marketing's own, whatever a page or route forgets.
--
-- (1) public.marketing_lock_all_tables(): ONE idempotent function that puts the lock on EVERY public table that is not marketing's own.
--     A RESTRICTIVE policy "marketing_blocked" is ANDed with whatever policies already exist, so a marketing token fails even where an
--     old policy only excluded 'client' and 'partner'. A table that still had row-level security OFF (the nine known ones, and any
--     other one found at run time) gets it switched ON with a permissive policy that keeps today's access for every logged-in token
--     EXCEPT marketing, so no screen goes blank; anonymous access has already ended (20261018-0050/0100).
--     EVERY FUTURE MIGRATION THAT CREATES A TABLE MUST END WITH `SELECT public.marketing_lock_all_tables();` — a unit test
--     (tests/unit/migrations-marketing-lock.test.ts) fails the build otherwise, so a forgotten lock is caught before it ships.
-- (2) Team membership and invites, and team-scoped read policies for the marketing tables. Writes stay server-only.
-- Idempotent. Undo: 20261018-0110-marketing-p1-db-lock.UNDO.sql (undo this BEFORE undoing 20261017-1900).
DO $$
BEGIN
  IF to_regclass('public.marketing_teams') IS NULL OR to_regclass('public.marketing_settings') IS NULL
     OR to_regclass('public.marketing_commission_terms') IS NULL THEN
    RAISE EXCEPTION 'Run 20261017-1900-marketing-p0-settings.sql FIRST: marketing_teams / marketing_settings / marketing_commission_terms are missing.';
  END IF;
END $$;

-- ── (3a) membership + invites ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_team_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,                              -- the person's auth login
  member_role text NOT NULL DEFAULT 'member' CHECK (member_role IN ('owner', 'member')),
  bundle      text,                                       -- the permission bundle's key (a setting), e.g. 'setter'
  permissions text[] NOT NULL DEFAULT '{}',               -- granted on top of the bundle; never more than the granter has
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'removed')),
  invited_by  text,
  invited_at  timestamptz NOT NULL DEFAULT now(),
  joined_at   timestamptz,
  removed_at  timestamptz,
  removed_by  text,
  token_version integer NOT NULL DEFAULT 1,               -- bumped on removal: signed links carry it and die
  UNIQUE (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_marketing_members_user ON marketing_team_members (user_id) WHERE status <> 'removed';

CREATE TABLE IF NOT EXISTS marketing_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      uuid NOT NULL REFERENCES marketing_teams(id) ON DELETE CASCADE,
  email_lower  text NOT NULL,
  member_role  text NOT NULL DEFAULT 'member' CHECK (member_role IN ('owner', 'member')),
  bundle       text,
  permissions  text[] NOT NULL DEFAULT '{}',
  token_hash   text NOT NULL UNIQUE,                      -- only the hash is stored; the link carries the token
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  revoked_at   timestamptz,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- who sent the invitation (by login id): an invitation dies with its sender's access (council fix 2026-10-18)
ALTER TABLE marketing_invites ADD COLUMN IF NOT EXISTS created_by_user_id uuid;
-- one OPEN invite per team and email
CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_invites_open
  ON marketing_invites (team_id, email_lower) WHERE used_at IS NULL AND revoked_at IS NULL;
ALTER TABLE marketing_team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_invites      ENABLE ROW LEVEL SECURITY;

-- ── (3b) who am I, without a policy that reads its own table (that would recurse) ────────────────────────────
CREATE OR REPLACE FUNCTION public.marketing_my_team_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT COALESCE(array_agg(team_id), '{}') FROM marketing_team_members WHERE user_id = auth.uid() AND status = 'active' $$;
CREATE OR REPLACE FUNCTION public.marketing_my_owner_team_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT COALESCE(array_agg(team_id), '{}') FROM marketing_team_members WHERE user_id = auth.uid() AND status = 'active' AND member_role = 'owner' $$;
REVOKE ALL ON FUNCTION public.marketing_my_team_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.marketing_my_owner_team_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketing_my_team_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.marketing_my_owner_team_ids() TO authenticated;

-- ── (3c) team-scoped READ policies (writes: server only, no policy) ──────────────────────────────────────────
DROP POLICY IF EXISTS marketing_read_own_team ON marketing_teams;
CREATE POLICY marketing_read_own_team ON marketing_teams FOR SELECT TO authenticated
  USING (id = ANY (public.marketing_my_team_ids()));
DROP POLICY IF EXISTS marketing_read_own_members ON marketing_team_members;
CREATE POLICY marketing_read_own_members ON marketing_team_members FOR SELECT TO authenticated
  USING (team_id = ANY (public.marketing_my_team_ids()));
DROP POLICY IF EXISTS marketing_read_team_settings ON marketing_settings;
CREATE POLICY marketing_read_team_settings ON marketing_settings FOR SELECT TO authenticated
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'marketing'
         AND (team_id IS NULL OR team_id = ANY (public.marketing_my_team_ids())));
-- commission terms and the settings history: the team OWNER only (members never need them)
DROP POLICY IF EXISTS marketing_owner_reads_terms ON marketing_commission_terms;
CREATE POLICY marketing_owner_reads_terms ON marketing_commission_terms FOR SELECT TO authenticated
  USING (team_id = ANY (public.marketing_my_owner_team_ids()));
-- invites and settings history: no policy at all = nobody but the server

-- ── (1) the standing lock: one function, run now and by EVERY migration that creates a table ──────────────────────
CREATE OR REPLACE FUNCTION public.marketing_lock_all_tables() RETURNS text[]
  LANGUAGE plpgsql SET search_path = public AS
$$
DECLARE r record; report text[] := '{}';
BEGIN
  FOR r IN SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname NOT LIKE 'marketing\_%' ESCAPE '\'
           ORDER BY c.relname
  LOOP
    BEGIN
      IF NOT r.relrowsecurity THEN
        -- it was open to every logged-in token: keep that for everyone EXCEPT marketing (no screen goes blank)
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
        EXECUTE format('DROP POLICY IF EXISTS logged_in_not_marketing ON public.%I', r.relname);
        EXECUTE format($f$CREATE POLICY logged_in_not_marketing ON public.%I FOR ALL TO authenticated
                          USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'marketing')
                          WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'marketing')$f$, r.relname);
        report := report || (r.relname || ': row-level security was OFF, switched on');
      END IF;
      EXECUTE format('DROP POLICY IF EXISTS marketing_blocked ON public.%I', r.relname);
      EXECUTE format($f$CREATE POLICY marketing_blocked ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
                        USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'marketing')
                        WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'marketing')$f$, r.relname);
    EXCEPTION WHEN OTHERS THEN
      -- never silent: a table we could not lock is reported (and the verification script lists it)
      RAISE WARNING 'marketing_lock_all_tables: % NOT locked: %', r.relname, SQLERRM;
      report := report || (r.relname || ': NOT LOCKED (' || SQLERRM || ')');
    END;
  END LOOP;
  RETURN report;
END
$$;
REVOKE ALL ON FUNCTION public.marketing_lock_all_tables() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketing_lock_all_tables() TO service_role;
SELECT public.marketing_lock_all_tables();

-- ── (3) database functions that take a user id as an argument must not be callable by ANY logged-in token ────
-- get_team_threads(p_user_id) and friends run with the owner's rights and trust the id they are handed: a logged-in client,
-- partner or marketing token could pass a staff member's id and read the team chat. Every caller in the code uses the SERVICE
-- key (verified 2026-10-18), which keeps its grant. Also taken away from logged-in tokens: functions that change data on behalf
-- of anyone (exec_sql, viewas_restore_*, onboarding_phase1, submit_member_info*, reset_tool_counter).
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'get_team_threads(uuid)','list_all_threads(uuid,integer,boolean)','list_later_threads(uuid)','list_followed_unread_threads(uuid)',
    'search_team_messages(uuid,text)','toggle_internal_message_reaction(uuid,text,text,text)','delete_thread_if_sole_author(uuid,uuid)',
    'exec_sql(text)','viewas_restore_auth_stamps(uuid,timestamptz,timestamptz)','viewas_restore_last_sign_in(uuid,timestamptz)',
    'onboarding_phase1(jsonb,jsonb,uuid,uuid)','submit_member_info(uuid,jsonb)','submit_member_info_v2(uuid,jsonb,jsonb)','reset_tool_counter()'
  ] LOOP
    IF to_regprocedure('public.' || f) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
    END IF;
  END LOOP;
END $$;
