-- UNDO of 20261113-1740-contact-calls.sql. Run it FIRST of the four booking UNDOs. Forgets the log of calls booked by existing contacts through made links
-- (the contact page "Booked calls" list and the Zoom filing's third read both tolerate the table being gone).

BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS public.contact_calls;

COMMIT;
