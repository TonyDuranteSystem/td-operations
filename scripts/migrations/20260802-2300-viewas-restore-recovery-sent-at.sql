-- View-as: ALSO restore a client's recovery_sent_at after an admin "View as client".
--
-- WHY (2026-08-02, Antonio): "when I click view as client is for technical stuff.
-- It shouldn't do anything anywhere." Correct — and the flow already honours that
-- for last_sign_in_at (see 20260615-2100). But it misses a second stamp.
--
-- View-as mints the client's session with generateLink({type:'magiclink'}), and
-- GoTrue writes auth.users.recovery_sent_at when it mints that link. PROVEN
-- CAUSALLY in sandbox 2026-08-02, not inferred: qa-e2e-pnl@tonydurante.us had
-- recovery_sent_at = NULL; one magiclink mint at 22:53:04.232Z; immediately after,
-- recovery_sent_at = 22:53:04.243512Z.
--
-- WHY IT MATTERS: that column is the obvious place to look when asking "did we
-- send this client a password-reset email?", and View-as fills it with false
-- positives. On production 2026-08-02: 100 users carried the stamp and 96 of them
-- fell within 120 SECONDS of a portal_view_as_enter row — i.e. the column was
-- measuring staff View-as clicks, not client resets. That misreading cost a full
-- session while diagnosing why client Chiara Fazzini received no reset email.
-- (Note the column is unreliable in the other direction too: a real successful
-- self-serve reset on PRODUCTION left it NULL. Do not trust it either way — the
-- authoritative record is now the action_log row written by
-- lib/portal/password-reset.ts. This migration stops View-as ADDING noise; it
-- does not make the column trustworthy.)
--
-- New function rather than replacing viewas_restore_last_sign_in: adding a third
-- argument would create a Postgres overload alongside the old 2-arg version.
-- One CREATE statement, so it stays promotable to production via execute_sql
-- (reason: migration:<filename>) exactly like its predecessor.
--
-- SECURITY: identical model to 20260615-2100 — SECURITY DEFINER to write
-- auth.users, self-guarded to service_role in the body (GRANT/REVOKE is not
-- available on the production promotion path), empty search_path.

CREATE OR REPLACE FUNCTION public.viewas_restore_auth_stamps(
  p_user_id uuid,
  p_last_sign_in timestamptz,
  p_recovery_sent timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(
       nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
       ''
     ) <> 'service_role' THEN
    RAISE EXCEPTION 'viewas_restore_auth_stamps: service_role only';
  END IF;
  UPDATE auth.users
     SET last_sign_in_at = p_last_sign_in,
         recovery_sent_at = p_recovery_sent
   WHERE id = p_user_id;
END;
$$;
