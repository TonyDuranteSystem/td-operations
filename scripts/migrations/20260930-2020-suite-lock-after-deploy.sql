-- Suite lock — RUN AFTER THE CODE IS DEPLOYED AND 20260930-2010 HAS RUN.
-- The shared Principal Office row stops printing ONE company's suite ("Suite 3D-205" is shown for ~186 companies).
-- (The "copy the suite from the company's own lease" door in the company lock is NOT handled here any more: it is closed
-- from the start in 20260930-2000 and only the one-time repair opens it, inside its own transaction.)
-- Safe to re-run.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- It is our Largo office, shared by everyone: the address is "10225 Ulmerton Rd, 3D" and each company's own
-- suite is overlaid from the company (portal, invoices, EIN application, AI client card). Do this only AFTER
-- the new code is live — the old code prints the row as stored, so every company would show a bare "3D".
UPDATE addresses SET address_line2 = '3D', updated_at = now()
WHERE id = '4706c595-f96e-4031-b44e-b83d0fb80251'
  AND is_td_provided = true
  AND address_line2 = 'Suite 3D-205';

COMMIT;

-- verify (expect address_line2 = '3D'):
-- SELECT address_line1, address_line2 FROM addresses WHERE id = '4706c595-f96e-4031-b44e-b83d0fb80251';
