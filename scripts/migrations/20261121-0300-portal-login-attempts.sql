-- A shared wrong-password counter for the team-login sign-in (dev job e59dd470, Team Powers bug hunt). SANDBOX FIRST; production only on Antonio's word.
--
-- WHY: the sign-in lockout lived in each server's memory. On the live site simultaneous requests are served by SEVERAL servers, each with its own count, so
-- a burst of guesses was only capped per server (measured on production on 21 Nov 2026: 14 parallel guesses, none locked). The count must live in ONE place.
--
-- ONE small table (a counter per key) and ONE function that CHECKS and COUNTS in a single locked step, so many guesses sent at the same moment — from any server —
-- are admitted exactly up to the limit and no further:
--   portal_login_reserve(key, max, window_seconds)  admits the attempt and counts it, unless the key is locked (then nothing is counted and the seconds left are returned).
--                                                   The max-th admitted attempt locks the key for window_seconds (same rule as the in-memory limiter it replaces).
--   portal_login_release(key)                       gives ONE counted attempt back (an attempt that turned out to be a success).
--   portal_login_clear(key)                         forgets the key (a success clears the address+username counter).
-- Keys look like 'teammate-login:<address>:<username>' — an address and a username, no password, no secret. Old rows are swept out now and then by the function itself.
-- No foreign keys on purpose. Nothing else in the database reads or writes this table.
-- The app falls back to its in-memory counter whenever this table or these functions are missing or erroring, so applying this before OR after the code is safe.
-- Locked: RLS on, no access for anon/authenticated (service client only), marketing lock re-run, AI read-only role revoked.
-- UNDO: 20261121-0300-portal-login-attempts.UNDO.sql

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"login-attempts-migration"}', true);

CREATE TABLE IF NOT EXISTS public.portal_login_attempts (
  key          text        PRIMARY KEY,
  failures     integer     NOT NULL DEFAULT 0,
  first_at     timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_login_attempts_updated ON public.portal_login_attempts (updated_at);

COMMENT ON TABLE public.portal_login_attempts IS
  'Shared wrong-password counters for the team-login sign-in (one row per key = address + username, address, or login). Written only by portal_login_reserve / release / clear, called by the app server. No secrets.';

-- Admits ONE attempt and counts it, atomically (the row is locked while it is decided). allowed = false: the key is locked, nothing was counted.
CREATE OR REPLACE FUNCTION public.portal_login_reserve(p_key text, p_max integer, p_window_seconds integer DEFAULT 900)
RETURNS TABLE (allowed boolean, retry_after_seconds integer)
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  r public.portal_login_attempts%ROWTYPE;
BEGIN
  -- make sure the row exists, then take its lock: simultaneous callers for the same key now go one after another
  INSERT INTO public.portal_login_attempts (key) VALUES (p_key) ON CONFLICT (key) DO NOTHING;
  SELECT * INTO r FROM public.portal_login_attempts t WHERE t.key = p_key FOR UPDATE;

  -- an expired lock, or a window that has run out, starts the count again
  IF (r.locked_until IS NOT NULL AND r.locked_until <= now())
     OR now() > r.first_at + make_interval(secs => p_window_seconds) THEN
    r.failures := 0;
    r.first_at := now();
    r.locked_until := NULL;
  END IF;

  -- still locked: refuse, count nothing
  IF r.locked_until IS NOT NULL THEN
    RETURN QUERY SELECT false, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (r.locked_until - now())))::integer);
    RETURN;
  END IF;

  r.failures := r.failures + 1;
  IF r.failures >= p_max THEN
    r.locked_until := now() + make_interval(secs => p_window_seconds);
  END IF;
  UPDATE public.portal_login_attempts t
     SET failures = r.failures, first_at = r.first_at, locked_until = r.locked_until, updated_at = now()
   WHERE t.key = p_key;

  -- now and then, sweep out counters nobody touched for a day
  IF random() < 0.01 THEN
    DELETE FROM public.portal_login_attempts t WHERE t.updated_at < now() - interval '1 day';
  END IF;

  RETURN QUERY SELECT true, 0;
END
$fn$;

-- Gives ONE counted attempt back (never reopens a key that is already locked).
CREATE OR REPLACE FUNCTION public.portal_login_release(p_key text)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  UPDATE public.portal_login_attempts t
     SET failures = GREATEST(t.failures - 1, 0), updated_at = now()
   WHERE t.key = p_key AND t.locked_until IS NULL;
  DELETE FROM public.portal_login_attempts t WHERE t.key = p_key AND t.locked_until IS NULL AND t.failures <= 0;
END
$fn$;

-- Forgets a key (the sign-in worked).
CREATE OR REPLACE FUNCTION public.portal_login_clear(p_key text)
RETURNS void
LANGUAGE sql
SET search_path = public
AS $fn$
  DELETE FROM public.portal_login_attempts WHERE key = p_key;
$fn$;

REVOKE ALL ON FUNCTION public.portal_login_reserve(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.portal_login_release(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.portal_login_clear(text) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.portal_login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_login_attempts FROM anon, authenticated;

-- The Slack worker and Hermes crm_query run as ai_readonly: keep the counters (addresses and usernames) out of its reach.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_readonly') THEN
    REVOKE ALL ON public.portal_login_attempts FROM ai_readonly;
    REVOKE ALL ON FUNCTION public.portal_login_reserve(text, integer, integer) FROM ai_readonly;
    REVOKE ALL ON FUNCTION public.portal_login_release(text) FROM ai_readonly;
    REVOKE ALL ON FUNCTION public.portal_login_clear(text) FROM ai_readonly;
  END IF;
END $$;

SELECT public.marketing_lock_all_tables();

-- Tell the API layer to pick up the new functions now (otherwise it can answer "function not found" for a little while after the change).
NOTIFY pgrst, 'reload schema';

COMMIT;
