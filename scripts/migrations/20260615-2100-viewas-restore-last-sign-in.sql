-- View-as: restore a client's last_sign_in_at after an admin "View as client" session.
--
-- WHY: View-as mints the client's session server-side (generateLink + verifyOtp),
-- and verifyOtp stamps auth.users.last_sign_in_at = now(). That pollutes the
-- "has this client ever logged in?" signal — it (a) hides the "Resend Welcome"
-- credentials button (gated on !last_sign_in_at) and (b) misreports "Last login"
-- to staff. The View-as entry route captures last_sign_in_at BEFORE minting and
-- calls this function AFTER, to put it back — so viewing a client never counts
-- as that client logging in.
--
-- SECURITY: SECURITY DEFINER so it can write auth.users (the app role can't).
-- Self-guards to the server's service_role in the body (instead of GRANT/REVOKE,
-- which the production execute_sql promotion path can't run) — so even though
-- public functions are exposed via PostgREST, anon/authenticated callers are
-- rejected. Single CREATE statement → promotable to prod via execute_sql.

CREATE OR REPLACE FUNCTION public.viewas_restore_last_sign_in(p_user_id uuid, p_ts timestamptz)
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
    RAISE EXCEPTION 'viewas_restore_last_sign_in: service_role only';
  END IF;
  UPDATE auth.users SET last_sign_in_at = p_ts WHERE id = p_user_id;
END;
$$;
