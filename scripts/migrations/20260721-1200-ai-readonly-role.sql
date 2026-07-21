-- AI SQL hardening — durable read-confidentiality control (Layer 2).
--
-- Closes two exploits proven against sandbox: (1) bcrypt-hash exfil from auth.users via
-- query_to_xml(concat(...)) — name-obfuscation defeats any text/regex block; (2) role-climb
-- via set_config('role','service_role') inside the SECURITY INVOKER read-only executor.
--
-- Fix: a clean low-privilege role `ai_readonly` (member of NOTHING) with broad SELECT on
-- public MINUS the secret/token tables, and `exec_sql_readonly` recreated as SECURITY DEFINER
-- OWNED BY `ai_readonly`. The query body then runs as `ai_readonly`; Postgres denies secret
-- tables at the planner regardless of spelling, and the definer frame makes SET ROLE /
-- SET SESSION AUTHORIZATION raise 42501. Verified live (Council Security confirm, 2026-07-21).
--
-- THREE MANDATORY REFINEMENTS (else regressions reopen):
--   1. BYPASSRLS on the role — 70 RLS tables would otherwise return silent-empty / permission
--      errors to the Slack worker and Hermes crm_query (money alarm + drift monitor read only
--      RLS-free / catalog tables, so they are safe either way). BYPASSRLS bypasses RLS POLICIES
--      only, never grant-level privilege — so revoked secret tables stay denied even with it on.
--   2. Restrict EXECUTE on the function to service_role (it was PUBLIC).
--   3. Ownership move needs transient CREATE on schema + SET-membership; both undone after.
--
-- The boundary is the GRANT, not the regex. The regex block below is only a friendlier error.
-- NOTE: GRANT SELECT ON ALL TABLES includes VIEWS. Today no view reads auth.*/token tables
-- (verified). If a non-security_invoker view over a secret table owned by postgres is ever
-- added, it would leak — create such views WITH (security_invoker=on).
--
-- SANDBOX FIRST (ref xjcxlmlpeywtwkhstjlw). Promote to production only with explicit approval.

-- 1. Clean role — NOT a member of anon/authenticated/service_role (load-bearing:
--    membership would re-expose the SECURITY DEFINER exec_sql function).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_readonly') THEN
    CREATE ROLE ai_readonly NOLOGIN;
  END IF;
END $$;

-- 2. RLS fix (H1). Secrets remain protected by grants (step 4), not by RLS.
ALTER ROLE ai_readonly BYPASSRLS;

-- 3. Broad read.
GRANT USAGE ON SCHEMA public TO ai_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ai_readonly;

-- 4. Subtractive: remove ONLY the secret/token surface. auth.* is a different schema and is
--    never granted to ai_readonly, so it is already unreadable.
REVOKE SELECT ON
  public.oauth_clients, public.oauth_codes, public.oauth_tokens, public.oauth_users,
  public.qb_tokens, public.hc_tokens, public.portal_welcome_tokens, public.push_subscriptions
  FROM ai_readonly;

-- 5. Future tables stay readable (all 217 today are owned by postgres; migrations + the
--    Supabase SQL editor both run as postgres). service_role line is belt-and-suspenders.
--    Standing manual step: a NEW secret table must be REVOKE'd from ai_readonly.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres     IN SCHEMA public GRANT SELECT ON TABLES TO ai_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE service_role IN SCHEMA public GRANT SELECT ON TABLES TO ai_readonly;

-- 6. Recreate the executor: SECURITY DEFINER (no SET ROLE), read-only + timeout + LIMIT kept.
--    Friendly-error regex widened to auth./push_subscriptions/encrypted_password — a nicer
--    message than a bare permission-denied; the ROLE is the actual boundary.
CREATE OR REPLACE FUNCTION public.exec_sql_readonly(sql_query text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  result json;
BEGIN
  IF lower(sql_query) ~ '\y(hc_tokens|oauth_clients|oauth_codes|oauth_tokens|oauth_users|portal_welcome_tokens|qb_tokens|push_subscriptions|encrypted_password)\y'
     OR lower(sql_query) ~ '\yauth\.' THEN
    RETURN json_build_object('error', 'Access to credential/token/auth tables is not permitted.');
  END IF;

  EXECUTE 'SET LOCAL transaction_read_only = on';
  EXECUTE 'SET LOCAL statement_timeout = ''8000ms''';
  EXECUTE 'SELECT coalesce(json_agg(t), ''[]''::json) FROM '
       || '(SELECT * FROM (' || sql_query || ') _inner LIMIT 500) t'
    INTO result;
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$$;

-- 7. Hand ownership to the clean role. Needs transient CREATE on schema + SET-membership;
--    both minimised immediately after so a read-only role keeps no create/session power.
GRANT ai_readonly TO postgres WITH SET TRUE;
GRANT CREATE ON SCHEMA public TO ai_readonly;
ALTER FUNCTION public.exec_sql_readonly(text) OWNER TO ai_readonly;
REVOKE CREATE ON SCHEMA public FROM ai_readonly;

-- 8. Restrict who can call it. CRITICAL: the executor is now SECURITY DEFINER owned by the
--    broadly-privileged ai_readonly, so ANY role that can EXECUTE it reads all business data.
--    Supabase's default privileges auto-grant EXECUTE on public functions to anon +
--    authenticated + service_role, and CREATE OR REPLACE above re-applies them — so revoking
--    PUBLIC alone is NOT enough. anon (unauthenticated API) and authenticated (logged-in
--    clients) MUST be revoked explicitly, or a client could read every tenant's data via the
--    PostgREST RPC. service_role is the only principal the four callers use (all via the
--    service key / supabaseAdmin). Verified in sandbox: the ACL retained anon/authenticated
--    after a PUBLIC-only revoke.
REVOKE EXECUTE ON FUNCTION public.exec_sql_readonly(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.exec_sql_readonly(text) TO service_role;
