-- UNDO of 20261118-1830-portal-login-email-changes.sql. Forgets every login-email change record, every wrong-password count and every open "This wasn't me" link.
-- Nothing else is touched: the logins and the contacts keep whatever email they have now.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('request.headers', '{"x-td-actor":"login-email-change-migration"}', true);

DROP FUNCTION IF EXISTS public.portal_login_email_take_attempt(uuid, uuid, integer, bigint);
DROP TABLE IF EXISTS public.portal_login_email_changes;

COMMIT;
