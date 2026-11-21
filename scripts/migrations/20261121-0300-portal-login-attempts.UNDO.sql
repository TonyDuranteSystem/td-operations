-- UNDO of 20261121-0300-portal-login-attempts.sql. Forgets every shared wrong-password counter and every current sign-in lock. Nothing else is touched.
-- The app keeps working: without these functions it falls back to its in-memory counter (per server), as it did before.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"login-attempts-migration"}', true);

DROP FUNCTION IF EXISTS public.portal_login_reserve(text, integer, integer);
DROP FUNCTION IF EXISTS public.portal_login_release(text);
DROP FUNCTION IF EXISTS public.portal_login_clear(text);
DROP TABLE IF EXISTS public.portal_login_attempts;

COMMIT;
