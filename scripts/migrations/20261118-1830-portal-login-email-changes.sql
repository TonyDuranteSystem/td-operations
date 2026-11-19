-- Client changes their OWN portal login email, with a code (dev job beb43385, step 2; Antonio 2026-11-18 "Start step 2"). SANDBOX FIRST; production only on Antonio's word.
--
-- ONE table keeps every change of a login email and every attempt around it, so the limits are real (kept in the database, not in server memory that resets on every deploy):
--   status 'pending'          a code was sent to the NEW address and has not been entered yet. At most ONE per login (unique index below), so a new request replaces the old one.
--   status 'confirmed'        the code was entered; the login moved. The "This wasn't me" link (undo_token_hash, undo_expires_at) works from the note sent to the OLD address.
--   status 'undone'           the link was used: the old email was put back and a new password was set.
--   status 'cancelled'        replaced by a newer request.
--   status 'password_check'  a password is being checked at step 1 (the attempt is written BEFORE the check, so a flood of parallel guesses is still counted).
--   status 'password_failed'  that password was wrong. No code was sent; the row only exists so wrong passwords can be counted per login.
-- The code and the undo token are NEVER stored: only a keyed hash of each (code_hash, undo_token_hash).
-- Every code attempt is counted by ONE small function (portal_login_email_take_attempt) that locks the row, adds one and returns it, so the limit of wrong codes
-- cannot be beaten by sending many guesses at the same moment.
-- contact_id has NO foreign key on purpose: this table must never constrain, merge-block or delete anything in contacts.
-- The values of status and requested_by live in code (lib/portal/login-email-change.ts), no CHECK list on purpose.
-- Locked: RLS on, no access for anon/authenticated (service client only), marketing lock re-run (lib/security/migration-lock-check.ts), AI read-only role revoked.
-- UNDO: 20261118-1830-portal-login-email-changes.UNDO.sql

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"login-email-change-migration"}', true);

CREATE TABLE IF NOT EXISTS public.portal_login_email_changes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id     uuid NOT NULL,
  contact_id       uuid NOT NULL,
  old_email        text NOT NULL,
  new_email        text NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  requested_by     text NOT NULL DEFAULT 'client',
  code_hash        text,
  code_sent_at     timestamptz,
  code_expires_at  timestamptz,
  code_attempts    integer NOT NULL DEFAULT 0,
  code_sends       integer NOT NULL DEFAULT 1,
  locked_until     timestamptz,
  confirmed_at     timestamptz,
  undo_token_hash  text,
  undo_expires_at  timestamptz,
  undone_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.portal_login_email_changes IS 'Every change of a portal login email (code sent / confirmed / undone) plus wrong-password attempts at step 1, so the limits survive deploys. Hashes only, never the code or the undo token. See docs/systems/portal.md.';
COMMENT ON COLUMN public.portal_login_email_changes.contact_id IS 'The contact the login belongs to. No foreign key on purpose.';

-- the limits and the latest change read by login, newest first
CREATE INDEX IF NOT EXISTS idx_portal_login_email_changes_user ON public.portal_login_email_changes (auth_user_id, created_at DESC);
-- one open request per login: a new request cancels the old one first, and two requests at the same moment cannot both stay open
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_login_email_changes_one_pending ON public.portal_login_email_changes (auth_user_id) WHERE status = 'pending';
-- the "This wasn't me" link finds its row by the hash of the token
CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_login_email_changes_undo_token ON public.portal_login_email_changes (undo_token_hash) WHERE undo_token_hash IS NOT NULL;

-- Counts ONE code attempt, atomically (row lock). Returns the row AFTER counting; taken = false means the attempt was refused (not open, locked, expired or out of attempts) and nothing was counted.
CREATE OR REPLACE FUNCTION public.portal_login_email_take_attempt(p_id uuid, p_user uuid, p_max integer, p_lock_ms bigint)
RETURNS TABLE (taken boolean, status text, code_hash text, code_expires_at timestamptz, code_attempts integer, locked_until timestamptz, contact_id uuid, old_email text, new_email text)
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  r public.portal_login_email_changes%ROWTYPE;
  did boolean := false;
BEGIN
  SELECT * INTO r FROM public.portal_login_email_changes c WHERE c.id = p_id AND c.auth_user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF r.status = 'pending'
     AND (r.locked_until IS NULL OR r.locked_until <= now())
     AND r.code_attempts < p_max
     AND r.code_expires_at IS NOT NULL AND r.code_expires_at > now() THEN
    r.code_attempts := r.code_attempts + 1;
    IF r.code_attempts >= p_max THEN
      r.locked_until := now() + (p_lock_ms::text || ' milliseconds')::interval;
    END IF;
    UPDATE public.portal_login_email_changes c
       SET code_attempts = r.code_attempts, locked_until = r.locked_until, updated_at = now()
     WHERE c.id = r.id;
    did := true;
  END IF;
  RETURN QUERY SELECT did, r.status, r.code_hash, r.code_expires_at, r.code_attempts, r.locked_until, r.contact_id, r.old_email, r.new_email;
END
$fn$;
REVOKE ALL ON FUNCTION public.portal_login_email_take_attempt(uuid, uuid, integer, bigint) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.portal_login_email_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.portal_login_email_changes FROM anon, authenticated;

-- The Slack worker and Hermes crm_query run as ai_readonly; a NEW table holding hashes of secrets must be REVOKEd from it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_readonly') THEN
    REVOKE ALL ON public.portal_login_email_changes FROM ai_readonly;
    REVOKE ALL ON FUNCTION public.portal_login_email_take_attempt(uuid, uuid, integer, bigint) FROM ai_readonly;
  END IF;
END $$;

SELECT public.marketing_lock_all_tables();

COMMIT;

-- verify (the Supabase SQL editor shows only this LAST result): RLS on, client_grants 0; ai_can_read must be false
SELECT c.relname, c.relrowsecurity AS rls_on,
       (SELECT count(*) FROM information_schema.role_table_grants g WHERE g.table_schema = 'public' AND g.table_name = c.relname AND g.grantee IN ('anon', 'authenticated')) AS client_grants,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_readonly')
            THEN has_table_privilege('ai_readonly', ('public.' || c.relname)::regclass, 'SELECT') END AS ai_can_read
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'portal_login_email_changes';
