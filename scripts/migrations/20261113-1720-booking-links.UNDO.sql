-- UNDO of 20261113-1720-booking-links.sql. Run it AFTER the contact_calls and call_checks UNDOs (they point at this table; a plain DROP TABLE refuses while they exist).
-- Nothing reads the table once the booking code is reverted or the `booking` setting is off. Dropping it forgets which links were made and which were used.

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS public.booking_links;

COMMIT;
