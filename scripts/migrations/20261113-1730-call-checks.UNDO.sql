-- UNDO of 20261113-1730-call-checks.sql. Run it AFTER the contact_calls UNDO and BEFORE the booking_links UNDO. Forgets every open and answered card.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS public.call_checks;

COMMIT;
